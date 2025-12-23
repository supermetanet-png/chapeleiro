
import express, { Request, RequestHandler } from 'express';
import cors from 'cors';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { AppStore } from './managers/AppStore.js'; 

dotenv.config();

// --- TYPE EXTENSIONS ---
interface CascataRequest extends Request {
  project?: any;
  projectPool?: pg.Pool;
  user?: any;
  userRole?: 'service_role' | 'authenticated' | 'anon';
  isSystemRequest?: boolean;
  file?: any;
  files?: any;
  body: any;
  params: any;
  query: any;
}

const app = express();

app.use(cors()); 
app.use(express.json({ limit: '100mb' }) as any);
app.use(express.urlencoded({ extended: true }) as any);

const { Pool } = pg;
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE AMBIENTE E FILESYSTEM ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORAGE_ROOT = path.resolve(__dirname, '../storage');
const APPS_ROOT = path.resolve(__dirname, '../storage/apps');
const MIGRATIONS_ROOT = path.resolve(__dirname, '../migrations');
const NGINX_DYNAMIC_ROOT = '/etc/nginx/conf.d/dynamic';

try {
  if (!fs.existsSync(STORAGE_ROOT)) fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  if (!fs.existsSync(APPS_ROOT)) fs.mkdirSync(APPS_ROOT, { recursive: true });
  if (!fs.existsSync(NGINX_DYNAMIC_ROOT)) fs.mkdirSync(NGINX_DYNAMIC_ROOT, { recursive: true });
} catch (e) { console.error('[System] Root dir create error:', e); }

const upload = multer({ dest: path.join(__dirname, '../uploads') });
const generateKey = () => crypto.randomBytes(32).toString('hex');

// --- 1. SYSTEM CONTROL PLANE POOL ---
const systemPool = new Pool({ 
  connectionString: process.env.SYSTEM_DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000 
});

// App Store Manager Initialization
const appStore = new AppStore(systemPool);

// --- INTEGRATED CERTIFICATE MANAGER ---
export type CertProvider = 'traefik' | 'certbot' | 'manual' | 'none';

class CertificateManager {
  private static basePath = '/etc/letsencrypt/live'; 
  private static systemCertPath = '/etc/letsencrypt/live/system';
  private static webrootPath = '/var/www/html';

  private static validateDomain(domain: string): boolean {
    const regex = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    return regex.test(domain) && !domain.includes('..');
  }

  private static reloadNginx() {
      const containerName = process.env.NGINX_CONTAINER_NAME || 'cascata-nginx';
      try {
          execSync(`docker exec ${containerName} nginx -s reload`);
      } catch (e: any) {
          console.error(`[CertManager] Failed to reload Nginx: ${e.message}`);
      }
  }

  public static async ensureSystemCert() {
    try {
        if (!fs.existsSync(this.systemCertPath)) {
            fs.mkdirSync(this.systemCertPath, { recursive: true });
        }
        const certFile = path.join(this.systemCertPath, 'fullchain.pem');
        const keyFile = path.join(this.systemCertPath, 'privkey.pem');
        if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
            execSync(`openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout ${keyFile} -out ${certFile} -subj "/C=US/ST=State/L=City/O=Cascata/CN=localhost"`, { stdio: 'ignore' });
        }
    } catch (e) { console.error('[CertManager] System cert error:', e); }
  }

  private static syncToSystem(sourceDir: string) {
      try {
          if (!fs.existsSync(this.systemCertPath)) fs.mkdirSync(this.systemCertPath, { recursive: true });
          const realCertPath = fs.realpathSync(path.join(sourceDir, 'fullchain.pem'));
          const realKeyPath = fs.realpathSync(path.join(sourceDir, 'privkey.pem'));
          fs.copyFileSync(realCertPath, path.join(this.systemCertPath, 'fullchain.pem'));
          fs.copyFileSync(realKeyPath, path.join(this.systemCertPath, 'privkey.pem'));
      } catch (e) { console.error('[CertManager] Sync failed:', e); }
  }

  public static async rebuildNginxConfigs() {
    console.log('[CertManager] Rebuilding Nginx dynamic configurations...');
    try {
      if (!fs.existsSync(NGINX_DYNAMIC_ROOT)) fs.mkdirSync(NGINX_DYNAMIC_ROOT, { recursive: true });

      const oldFiles = fs.readdirSync(NGINX_DYNAMIC_ROOT);
      for (const file of oldFiles) {
        if (file.endsWith('.conf')) fs.unlinkSync(path.join(NGINX_DYNAMIC_ROOT, file));
      }

      // PROJECTS
      const result = await systemPool.query('SELECT slug, custom_domain, ssl_certificate_source FROM system.projects WHERE custom_domain IS NOT NULL');
      for (const proj of result.rows) {
        if (!proj.custom_domain) continue;
        const certDomain = proj.ssl_certificate_source || proj.custom_domain;
        const certPath = path.join(this.basePath, certDomain);
        
        if (fs.existsSync(path.join(certPath, 'fullchain.pem')) && fs.existsSync(path.join(certPath, 'privkey.pem'))) {
          const configContent = `
server {
    listen 443 ssl;
    server_name ${proj.custom_domain};
    ssl_certificate /etc/letsencrypt/live/${certDomain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${certDomain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    client_max_body_size 100M;
    location / {
        proxy_pass http://cascata-backend-data:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;
          fs.writeFileSync(path.join(NGINX_DYNAMIC_ROOT, `${proj.slug}.conf`), configContent.trim());
        }
      }

      // APPS (APPS ORCHESTRATOR)
      const apps = await systemPool.query("SELECT * FROM system.apps WHERE status = 'running'");
      for (const app of apps.rows) {
          const certPath = path.join(this.basePath, app.domain);
          if (fs.existsSync(path.join(certPath, 'fullchain.pem'))) {
              const appConfig = `
server {
    listen 443 ssl;
    server_name ${app.domain};
    ssl_certificate /etc/letsencrypt/live/${app.domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${app.domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    client_max_body_size 500M;
    location / {
        proxy_pass http://${app.container_name_main}:${app.port_internal};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}`;
              fs.writeFileSync(path.join(NGINX_DYNAMIC_ROOT, `app_${app.id}.conf`), appConfig.trim());
          }
      }
      
      this.reloadNginx();
    } catch (e) {
      console.error('[CertManager] Failed to rebuild configs:', e);
    }
  }

  public static async deleteCertificate(domain: string): Promise<void> {
      const domainDir = path.join(this.basePath, domain);
      if (fs.existsSync(domainDir)) {
          fs.rmSync(domainDir, { recursive: true, force: true });
          const archiveDir = path.join('/etc/letsencrypt/archive', domain);
          if (fs.existsSync(archiveDir)) fs.rmSync(archiveDir, { recursive: true, force: true });
          const renewalFile = path.join('/etc/letsencrypt/renewal', `${domain}.conf`);
          if (fs.existsSync(renewalFile)) fs.unlinkSync(renewalFile);
          await this.rebuildNginxConfigs();
      } else {
          throw new Error("Certificado não encontrado.");
      }
  }

  public static async detectEnvironment(): Promise<any> {
    const domains: string[] = [];
    if (fs.existsSync(this.basePath)) {
      try {
        const dirs = fs.readdirSync(this.basePath).filter(f => 
          fs.lstatSync(path.join(this.basePath, f)).isDirectory() && f !== 'system'
        );
        domains.push(...dirs);
      } catch (e) { }
    }
    let hasCertbot = false;
    try { if (fs.existsSync('/usr/bin/certbot') || fs.existsSync('/usr/local/bin/certbot')) hasCertbot = true; } catch(e) {}
    return { provider: hasCertbot ? 'certbot' : 'manual', active: domains.length > 0, domains, message: `${domains.length} domínios configurados.` };
  }

  public static async requestCertificate(domain: string, email: string, provider: CertProvider, manualData?: { cert: string, key: string }, isSystem: boolean = false): Promise<{ success: boolean, message: string }> {
    if (!this.validateDomain(domain)) throw new Error("Domínio inseguro ou inválido.");
    const domainDir = path.join(this.basePath, domain);
    const finishSetup = async () => {
      if (isSystem) this.syncToSystem(domainDir);
      await this.rebuildNginxConfigs();
    };

    if (provider === 'manual' || provider === 'cloudflare_pem' as any) {
        if (!manualData?.cert || !manualData?.key) throw new Error("Cert/Key required.");
        if (!fs.existsSync(this.basePath)) fs.mkdirSync(this.basePath, { recursive: true });
        if (!fs.existsSync(domainDir)) fs.mkdirSync(domainDir, { recursive: true });
        fs.writeFileSync(path.join(domainDir, 'fullchain.pem'), manualData.cert.trim());
        fs.writeFileSync(path.join(domainDir, 'privkey.pem'), manualData.key.trim());
        await finishSetup();
        return { success: true, message: "Certificados manuais instalados." };
    }

    if (provider === 'certbot' || provider === 'letsencrypt' as any) {
        if (!email.includes('@')) throw new Error("Email inválido.");
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(this.webrootPath)) fs.mkdirSync(this.webrootPath, { recursive: true });
            const certbot = spawn('certbot', [
                'certonly', '--webroot', '-w', this.webrootPath, '-d', domain,
                '--email', email, '--agree-tos', '--no-eff-email', '--force-renewal', '--non-interactive'
            ]);
            let log = '';
            certbot.stdout.on('data', d => log += d.toString());
            certbot.stderr.on('data', d => log += d.toString());
            certbot.on('close', async (code) => {
                if (code === 0) {
                    try { await finishSetup(); resolve({ success: true, message: "Certificado gerado com sucesso!" }); } catch (e: any) { reject(new Error(`Falha pós-certbot: ${e.message}`)); }
                } else reject(new Error(`Falha no Certbot (Code ${code}): ${log.slice(-300)}`));
            });
        });
    }
    throw new Error("Provider desconhecido.");
  }
}

// --- HELPER: WAIT FOR DB ---
const waitForDatabase = async (retries = 10, delay = 2000): Promise<boolean> => {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await systemPool.connect();
      client.release();
      console.log('[System] Database connected successfully.');
      return true;
    } catch (err: any) {
      console.warn(`[System] Waiting for database... (${i + 1}/${retries}) - ${err.message}`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
  return false;
};

// --- MIGRATION RUNNER (ROBUST & INLINE FALLBACK) ---
// THIS FIXES THE 500 ERROR BY GUARANTEEING TABLES EXIST EVEN IF SQL FILES FAIL
class MigrationRunner {
  public static async run() {
    console.log('[MigrationRunner] Check started...');
    let client;
    try {
      client = await systemPool.connect();
      
      // 1. BOOTSTRAP SYSTEM SCHEMA & EXTENSIONS
      await client.query(`CREATE SCHEMA IF NOT EXISTS system`);
      await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
      await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

      // 2. CRITICAL TABLES (INLINE SQL - SAFETY NET)
      // Projects Table
      await client.query(`
        CREATE TABLE IF NOT EXISTS system.projects (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            name TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL DEFAULT 'healthy',
            db_name TEXT UNIQUE NOT NULL, 
            custom_domain TEXT UNIQUE,
            default_domain TEXT UNIQUE,
            ssl_certificate_source TEXT,
            jwt_secret TEXT NOT NULL,
            anon_key TEXT NOT NULL,
            service_key TEXT NOT NULL,
            blocklist TEXT[] DEFAULT '{}',
            metadata JSONB DEFAULT '{}',
            log_retention_days INTEGER DEFAULT 30,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Admin Users Table (Fixes the login 500 error)
      await client.query(`
        CREATE TABLE IF NOT EXISTS system.admin_users (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Default Admin User
      await client.query(`
        INSERT INTO system.admin_users (email, password_hash) 
        SELECT 'admin@cascata.io', 'admin123'
        WHERE NOT EXISTS (SELECT 1 FROM system.admin_users WHERE email = 'admin@cascata.io');
      `);

      // UI Settings Table
      await client.query(`
        CREATE TABLE IF NOT EXISTS system.ui_settings (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            project_slug TEXT NOT NULL,
            table_name TEXT NOT NULL,
            settings JSONB NOT NULL,
            UNIQUE(project_slug, table_name)
        );
      `);

      // Apps Table (New Feature)
      await client.query(`
        CREATE TABLE IF NOT EXISTS system.apps (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            project_slug TEXT NOT NULL,
            type TEXT NOT NULL,
            domain TEXT NOT NULL,
            port_internal INTEGER,
            container_name_main TEXT,
            env_vars JSONB DEFAULT '{}',
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 3. FILE BASED MIGRATIONS (SECONDARY)
      await client.query(`
        CREATE TABLE IF NOT EXISTS system.migrations (
          id SERIAL PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          applied_at TIMESTAMP DEFAULT NOW()
        )
      `);

      if (fs.existsSync(MIGRATIONS_ROOT)) {
        const files = fs.readdirSync(MIGRATIONS_ROOT)
          .filter(f => f.endsWith('.sql') || f.endsWith('.sql.txt'))
          .sort();

        for (const file of files) {
          const check = await client.query('SELECT id FROM system.migrations WHERE name = $1', [file]);
          if (check.rowCount === 0) {
            console.log(`[MigrationRunner] Applying external: ${file}`);
            const sql = fs.readFileSync(path.join(MIGRATIONS_ROOT, file), 'utf-8');
            try {
              await client.query('BEGIN');
              await client.query(sql);
              await client.query('INSERT INTO system.migrations (name) VALUES ($1)', [file]);
              await client.query('COMMIT');
            } catch (err: any) {
              await client.query('ROLLBACK');
              console.warn(`[MigrationRunner] External migration ${file} failed (Skipping): ${err.message}`);
            }
          }
        }
      }
      
      await CertificateManager.rebuildNginxConfigs();

    } catch (e: any) {
      console.error('[MigrationRunner] Critical Error:', e.message);
    } finally {
      if (client) client.release();
    }
  }
}

// --- 2. POOL MANAGER (ISOLAMENTO & PERFORMANCE) ---
class PoolManager {
  private static pools = new Map<string, pg.Pool>();

  public static get(dbName: string): pg.Pool {
    if (this.pools.has(dbName)) {
      return this.pools.get(dbName)!;
    }

    const baseUrl = process.env.SYSTEM_DATABASE_URL || '';
    let dbUrl = '';
    if (baseUrl.includes(' ')) {
       console.error("Critical: Use connection string URI format for SYSTEM_DATABASE_URL");
       throw new Error("Invalid connection string format");
    } else {
       dbUrl = baseUrl.replace(/\/[^\/?]+(\?.*)?$/, `/${dbName}$1`);
    }

    const pool = new Pool({
      connectionString: dbUrl,
      max: 15,
      idleTimeoutMillis: 120000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error(`[PoolManager] Erro no banco ${dbName}:`, err.message);
    });

    this.pools.set(dbName, pool);
    return pool;
  }

  public static async close(dbName: string) {
    if (this.pools.has(dbName)) {
      await this.pools.get(dbName)?.end();
      this.pools.delete(dbName);
    }
  }
}

// --- 3. SECURITY UTILS ---
const quoteId = (identifier: string) => {
  if (typeof identifier !== 'string') throw new Error("Invalid identifier");
  return `"${identifier.replace(/"/g, '""')}"`;
};

// --- HELPER: RLS SESSION INJECTOR ---
const queryWithRLS = async (req: CascataRequest, callback: (client: pg.PoolClient) => Promise<any>) => {
  if (!req.projectPool) throw new Error("Database connection not initialized");
  
  const client = await req.projectPool.connect();
  try {
    if (req.userRole === 'service_role') {
        await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
    } else if (req.user && req.user.sub) {
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [req.user.sub]);
      await client.query("SELECT set_config('request.jwt.claim.role', $1, true)", [req.userRole]);
    } else {
      await client.query("SELECT set_config('request.jwt.claim.role', 'anon', true)");
    }
    const result = await callback(client);
    return result;
  } catch (e) {
    throw e;
  } finally {
    client.release();
  }
};

const parseBytes = (sizeStr: string): number => {
  if (!sizeStr) return 10 * 1024 * 1024; 
  const match = sizeStr.toString().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!match) return parseInt(sizeStr) || 0;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  const multipliers: Record<string, number> = { 'B': 1, 'KB': 1024, 'MB': 1024 * 1024, 'GB': 1024 * 1024 * 1024 };
  return Math.floor(num * (multipliers[unit] || 1));
};

const getSectorForExt = (ext: string): string => {
  const map: Record<string, string[]> = {
    visual: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'avif', 'heic', 'heif'],
    motion: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'm4p', 'amr', 'mid', 'midi', 'opus'],
    docs: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'pages', 'epub', 'mobi', 'azw3'],
    structured: ['csv', 'json', 'xml', 'yaml', 'yml', 'sql', 'xls', 'xlsx', 'ods', 'tsv', 'parquet', 'avro'],
    archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'iso', 'dmg', 'pkg', 'xz', 'zst'],
    exec: ['exe', 'msi', 'bin', 'app', 'deb', 'rpm', 'sh', 'bat', 'cmd', 'vbs', 'ps1'],
    scripts: ['js', 'ts', 'py', 'rb', 'php', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'cs', 'swift', 'kt'],
    config: ['env', 'config', 'ini', 'xml', 'manifest', 'lock', 'gitignore', 'editorconfig', 'toml'],
    telemetry: ['log', 'dump', 'out', 'err', 'crash', 'report', 'audit'],
    messaging: ['eml', 'msg', 'vcf', 'chat', 'ics', 'pbx'],
    ui_assets: ['ttf', 'otf', 'woff', 'woff2', 'eot', 'sketch', 'fig', 'ai', 'psd', 'xd'],
    simulation: ['obj', 'stl', 'fbx', 'dwg', 'dxf', 'dae', 'blend', 'step', 'iges', 'glf', 'gltf', 'glb'],
    backup_sys: ['bak', 'sql', 'snapshot', 'dump', 'db', 'sqlite', 'sqlite3', 'rdb']
  };
  for (const sector in map) {
    if (map[sector].includes(ext)) return sector;
  }
  return 'global';
};

// --- 4. MIDDLEWARES CORE ---

const controlPlaneFirewall: RequestHandler = async (req: any, res: any, next: any) => {
  if (req.method !== 'OPTIONS' && req.path.startsWith('/api/control/projects/')) {
    const slug = req.path.split('/')[4]; 
    if (slug) {
        const forwarded = req.headers['x-forwarded-for'];
        const realIp = req.headers['x-real-ip'];
        const socketIp = req.socket?.remoteAddress;
        let clientIp = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
        clientIp = clientIp.replace('::ffff:', '');

        if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.startsWith('172.') || clientIp.startsWith('10.')) {
            return next();
        }

        try {
            const result = await systemPool.query('SELECT blocklist FROM system.projects WHERE slug = $1', [slug]);
            if (result.rows.length > 0) {
                const blocklist = result.rows[0].blocklist || [];
                if (blocklist.includes(clientIp)) {
                    res.status(403).json({ error: 'Firewall: Access Denied' });
                    return;
                }
            }
        } catch (e) {
            // Fail open
        }
    }
  }
  next();
};

const resolveProject: RequestHandler = async (req: any, res: any, next: any) => {
  if (req.path.startsWith('/api/control/')) return next();
  if (req.path === '/' || req.path === '/health') return next(); 
  
  const r = req as CascataRequest;
  const host = req.headers.host || '';
  
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : (req.query.token as string);
  r.isSystemRequest = false;
  
  if (bearerToken) {
    try {
      jwt.verify(bearerToken, process.env.SYSTEM_JWT_SECRET || 'fallback_secret');
      r.isSystemRequest = true;
    } catch { }
  }

  const pathParts = req.path.split('/');
  const slugFromUrl = (pathParts.length > 3 && pathParts[1] === 'api' && pathParts[2] === 'data') ? pathParts[3] : null;

  try {
    let projectResult: pg.QueryResult | undefined;
    let resolutionMethod = 'unknown';

    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      projectResult = await systemPool.query('SELECT * FROM system.projects WHERE custom_domain = $1', [host]);
      if ((projectResult.rowCount ?? 0) > 0) resolutionMethod = 'domain';
    }

    if ((!projectResult || (projectResult.rowCount ?? 0) === 0) && slugFromUrl) {
      projectResult = await systemPool.query('SELECT * FROM system.projects WHERE slug = $1', [slugFromUrl]);
      if ((projectResult.rowCount ?? 0) > 0) resolutionMethod = 'slug';
    }

    if (!projectResult || !projectResult.rows[0]) {
      if (req.path.startsWith('/api/data/')) {
        res.status(404).json({ error: 'Project Context Not Found (404)' });
        return;
      }
      return next(); 
    }

    const project = projectResult.rows[0];

    if (project.custom_domain && resolutionMethod === 'slug') {
      const isDev = host.includes('localhost') || host.includes('127.0.0.1');
      if (!isDev && !r.isSystemRequest) {
        res.status(403).json({ 
          error: 'Domain Locking Policy: This project accepts requests only via its configured custom domain.',
          hint: 'Use the custom domain API endpoint.'
        });
        return;
      }
    }

    if (resolutionMethod === 'domain' && !req.url.startsWith('/api/data/')) {
      req.url = `/api/data/${project.slug}${req.url}`;
    }

    const forwarded = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    const socketIp = req.socket?.remoteAddress;
    let clientIp = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
    clientIp = clientIp.replace('::ffff:', '');
    
    if (project.blocklist && project.blocklist.includes(clientIp)) {
      res.status(403).json({ error: 'Firewall: Access Denied (Blocked Origin)' });
      return;
    }

    r.project = project;

    try {
      r.projectPool = PoolManager.get(project.db_name);
    } catch (err) {
      console.error("Infrastructure Error:", err);
      res.status(502).json({ error: 'Database Connection Failed' });
      return;
    }

    next();
  } catch (e) {
    console.error("Resolution Middleware Fatal:", e);
    res.status(500).json({ error: 'Internal Resolution Error' });
  }
};

const cascataAuth: RequestHandler = async (req: any, res: any, next: any) => {
  const r = req as CascataRequest;

  if (req.path.startsWith('/api/control/')) {
    if (req.path.endsWith('/auth/login') || req.path.endsWith('/auth/verify') || req.path.includes('/system/ssl-check')) return next();
    
    const authHeader = req.headers['authorization'];
    if (!authHeader) { res.status(401).json({ error: 'Missing Admin Token' }); return; }
    
    try {
      const token = authHeader.split(' ')[1];
      jwt.verify(token, process.env.SYSTEM_JWT_SECRET || 'fallback_secret');
      return next();
    } catch { 
      res.status(401).json({ error: 'Invalid Admin Token' });
      return;
    }
  }

  if (!r.project) { 
      if (req.path === '/' || req.path === '/health') return next();
      res.status(404).json({ error: 'No Project Context' }); 
      return; 
  }

  if (r.isSystemRequest) {
    r.userRole = 'service_role';
    return next();
  }

  const apiKey = (req.headers['apikey'] as string) || (req.query.apikey as string);
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : (req.query.token as string);

  if (apiKey === r.project.service_key || bearerToken === r.project.service_key) {
    r.userRole = 'service_role';
    return next();
  }

  if (bearerToken) {
    try {
      const decoded = jwt.verify(bearerToken, r.project.jwt_secret);
      r.user = decoded;
      r.userRole = 'authenticated';
      return next();
    } catch (e) { /* Fallback to anon */ }
  }

  if (apiKey === r.project.anon_key) {
    r.userRole = 'anon';
    return next();
  }

  if (req.path.includes('/auth/users') || req.path.includes('/auth/token')) {
      r.userRole = 'anon';
      return next();
  }

  res.status(401).json({ error: 'Unauthorized: Invalid API Key or JWT.' });
};

const detectSemanticAction = (method: string, path: string): string | null => {
    if (path.includes('/tables') && method === 'POST' && path.endsWith('/rows')) return 'INSERT_ROWS';
    if (path.includes('/tables') && method === 'POST') return 'CREATE_TABLE';
    if (path.includes('/tables') && method === 'DELETE' && !path.includes('/rows')) return 'DROP_TABLE';
    if (path.includes('/tables') && method === 'DELETE' && path.includes('/rows')) return 'DELETE_ROWS';
    if (path.includes('/tables') && method === 'PUT') return 'UPDATE_ROWS';
    if (path.includes('/auth/token')) return 'AUTH_LOGIN';
    if (path.includes('/auth/users') && method === 'POST') return 'AUTH_REGISTER';
    if (path.includes('/storage') && method === 'POST' && path.includes('/upload')) return 'UPLOAD_FILE';
    if (path.includes('/storage') && method === 'DELETE') return 'DELETE_FILE';
    return null;
};

const auditLogger: RequestHandler = (req: any, res: any, next: any) => {
  const start = Date.now();
  const oldJson = res.json;
  const r = req as CascataRequest;

  (res as any).json = function(data: any) {
    if (r.project) {
       const duration = Date.now() - start;
       const isUpload = req.headers['content-type']?.includes('multipart/form-data');
       const payload = isUpload ? { type: 'binary_upload' } : req.body;
       
       const forwarded = req.headers['x-forwarded-for'];
       const realIp = req.headers['x-real-ip'];
       const socketIp = (req as any).socket?.remoteAddress;
       let clientIp = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
       clientIp = clientIp.replace('::ffff:', '');
       
       const isInternal = req.headers['x-cascata-client'] === 'dashboard' || r.isSystemRequest;
       const semanticAction = detectSemanticAction(req.method, req.path);

       const geoInfo = {
         is_internal: isInternal,
         auth_status: res.statusCode >= 400 ? 'SECURITY_ALERT' : 'GRANTED',
         semantic_action: semanticAction
       };

       if (res.statusCode === 401 && r.project.metadata?.security?.auto_block_401) {
          const isSafeIp = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp.startsWith('172.') || clientIp.startsWith('10.') || clientIp.startsWith('192.168.'); 
          
          if (!isSafeIp && !r.project.blocklist?.includes(clientIp)) {
             console.warn(`[Auto-Block] Banning IP ${clientIp} due to invalid auth on ${r.project.slug}`);
             systemPool.query(
                'UPDATE system.projects SET blocklist = array_append(blocklist, $1) WHERE slug = $2', 
                [clientIp, r.project.slug]
             ).catch(err => console.error("Auto-block failed", err));
          }
       }

       systemPool.query(
        `INSERT INTO system.api_logs (project_slug, method, path, status_code, client_ip, duration_ms, user_role, payload, headers, geo_info) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          r.project.slug, req.method, req.path, res.statusCode, 
          clientIp, duration, r.userRole || 'unauthorized',
          JSON.stringify(payload).substring(0, 2000),
          JSON.stringify({ referer: req.headers.referer, userAgent: req.headers['user-agent'] }),
          JSON.stringify(geoInfo)
        ]
       ).catch(err => console.error("Audit log error", err));
    }
    return oldJson.apply(res, arguments as any);
  }
  next();
};

app.use(resolveProject as any);
app.use(controlPlaneFirewall as any);
app.use(auditLogger as any); 
app.use(cascataAuth as any);

// --- ROUTES ---

app.get('/', (req, res) => { res.send('Cascata Engine OK'); });
app.get('/health', (req, res) => { res.json({ status: 'ok', time: new Date() }); });

// --- CONTROL PLANE: STORE & APPS (NEW) ---

// 1. Get Store Listing
app.get('/api/control/store/apps', async (req: any, res: any) => {
    try {
        const apps = await appStore.fetchStoreListing();
        res.json(apps);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 2. Install App
app.post('/api/control/projects/:slug/apps/install', async (req: any, res: any) => {
    const { appId, domain } = req.body;
    try {
        const result = await appStore.installApp(req.params.slug, appId, domain);
        await CertificateManager.rebuildNginxConfigs();
        res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 3. List Installed Apps
app.get('/api/control/projects/:slug/apps', async (req: any, res: any) => {
    try {
        const result = await systemPool.query('SELECT * FROM system.apps WHERE project_slug = $1', [req.params.slug]);
        res.json(result.rows);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// 4. App Actions
app.delete('/api/control/projects/:slug/apps/:id', async (req: any, res: any) => {
    try {
        await appStore.deleteApp(req.params.id);
        await CertificateManager.rebuildNginxConfigs();
        res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/control/projects/:slug/apps/:id/action', async (req: any, res: any) => {
    const { action } = req.body;
    try {
        if (action === 'stop') await appStore.stopApp(req.params.id);
        else if (action === 'start') await appStore.startApp(req.params.id);
        await CertificateManager.rebuildNginxConfigs();
        res.json({ success: true });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/control/projects/:slug/apps/:id/logs', async (req: any, res: any) => {
    try {
        const logs = await appStore.getLogs(req.params.id);
        res.json({ logs });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- EXISTING CONTROL PLANE ROUTES (PRESERVED) ---

app.post('/api/control/auth/login', async (req: any, res: any) => {
  const { email, password } = req.body;
  try {
    const result = await systemPool.query('SELECT * FROM system.admin_users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (user && user.password_hash === password) {
      const token = jwt.sign({ sub: user.id, role: 'superadmin' }, process.env.SYSTEM_JWT_SECRET!, { expiresIn: '12h' });
      res.json({ token });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/control/auth/verify', async (req: any, res: any) => {
  const { password } = req.body;
  try {
    const result = await systemPool.query('SELECT * FROM system.admin_users LIMIT 1');
    const user = result.rows[0];
    if (user && user.password_hash === password) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.put('/api/control/auth/profile', async (req: any, res: any) => {
  const { email, password } = req.body;
  try {
    if (password) {
      await systemPool.query('UPDATE system.admin_users SET email = $1, password_hash = $2', [email, password]);
    } else {
      await systemPool.query('UPDATE system.admin_users SET email = $1', [email]);
    }
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/control/system/settings', async (req: any, res: any) => {
  try {
    const result = await systemPool.query(
      "SELECT settings FROM system.ui_settings WHERE project_slug = '_system_root_' AND table_name = 'domain_config'"
    );
    res.json(result.rows[0]?.settings || {});
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/control/system/settings', async (req: any, res: any) => {
  const { domain } = req.body;
  try {
    await systemPool.query(
      `INSERT INTO system.ui_settings (project_slug, table_name, settings) 
       VALUES ('_system_root_', 'domain_config', $1) 
       ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $1`,
      [JSON.stringify({ domain })]
    );
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/control/system/ssl-check', async (req: any, res: any) => {
  const { domain } = req.body;
  if (!domain) { res.status(400).json({ error: 'Domain required' }); return; }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    await fetch(`https://${domain}`, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeoutId);
    res.json({ status: 'active' });
  } catch (e: any) {
    res.json({ status: 'inactive', error: e.message });
  }
});

app.get('/api/control/projects', async (req: any, res: any) => {
  try {
    const result = await systemPool.query('SELECT * FROM system.projects ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/control/projects', async (req: any, res: any) => {
  const { name, slug } = req.body;
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const dbName = `cascata_db_${safeSlug.replace(/-/g, '_')}`;
  let tempClient: pg.Client | null = null;

  try {
    const insertRes = await systemPool.query(
      `INSERT INTO system.projects (name, slug, db_name, anon_key, service_key, jwt_secret, metadata) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, safeSlug, dbName, generateKey(), generateKey(), generateKey(), '{}']
    );

    await systemPool.query(`CREATE DATABASE ${quoteId(dbName)}`);

    const baseUrl = process.env.SYSTEM_DATABASE_URL || '';
    const newDbUrl = baseUrl.replace(/\/[^\/?]+(\?.*)?$/, `/${dbName}$1`);
    
    tempClient = new pg.Client({ connectionString: newDbUrl });
    await tempClient.connect();

    await tempClient.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        created_at TIMESTAMPTZ DEFAULT now(),
        last_sign_in_at TIMESTAMPTZ,
        banned BOOLEAN DEFAULT false,
        raw_user_meta_data JSONB DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS auth.identities (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        identifier TEXT NOT NULL,
        password_hash TEXT,
        identity_data JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT now(),
        last_sign_in_at TIMESTAMPTZ,
        UNIQUE(provider, identifier)
      );
      CREATE TABLE IF NOT EXISTS auth.otp_codes (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        identifier TEXT NOT NULL,
        provider TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA auth TO service_role;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
    `);

    res.json(insertRes.rows[0]);
  } catch (e: any) {
    if (tempClient) await tempClient.end();
    await systemPool.query('DELETE FROM system.projects WHERE slug = $1', [safeSlug]).catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    if (tempClient) await tempClient.end();
  }
});

app.delete('/api/control/projects/:slug', async (req: any, res: any) => {
  const { slug } = req.params;
  try {
    const result = await systemPool.query('SELECT * FROM system.projects WHERE slug = $1', [slug]);
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Project not found' }); return; }
    const project = result.rows[0];
    await PoolManager.close(project.db_name);
    try {
        await systemPool.query(`DROP DATABASE IF EXISTS ${quoteId(project.db_name)}`);
    } catch (dbErr: any) {
        await systemPool.query(`SELECT pg_terminate_backend(pg_stat_activity.pid) FROM pg_stat_activity WHERE pg_stat_activity.datname = $1 AND pid <> pg_backend_pid()`, [project.db_name]);
        await systemPool.query(`DROP DATABASE IF EXISTS ${quoteId(project.db_name)}`);
    }
    await systemPool.query('DELETE FROM system.projects WHERE slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.assets WHERE project_slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.webhooks WHERE project_slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.api_logs WHERE project_slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.ui_settings WHERE project_slug = $1', [slug]);
    await systemPool.query('DELETE FROM system.apps WHERE project_slug = $1', [slug]);
    const storagePath = path.join(STORAGE_ROOT, slug);
    if (fs.existsSync(storagePath)) fs.rmSync(storagePath, { recursive: true, force: true });
    await CertificateManager.rebuildNginxConfigs();
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/control/projects/:slug', async (req: any, res: any) => {
  const { custom_domain, log_retention_days, metadata, ssl_certificate_source } = req.body;
  try {
    let metadataQueryPart = 'metadata'; 
    const params = [custom_domain, log_retention_days, req.params.slug, ssl_certificate_source];
    let paramIdx = 5;
    if (metadata) {
        metadataQueryPart = `COALESCE(metadata, '{}'::jsonb) || $${paramIdx}::jsonb`;
        params.push(JSON.stringify(metadata));
    }
    const result = await systemPool.query(
      `UPDATE system.projects SET custom_domain = COALESCE($1, custom_domain), log_retention_days = COALESCE($2, log_retention_days), ssl_certificate_source = COALESCE($4, ssl_certificate_source), metadata = ${metadataQueryPart}, updated_at = now() WHERE slug = $3 RETURNING *`,
      params
    );
    await CertificateManager.rebuildNginxConfigs();
    res.json(result.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/control/projects/:slug/rotate-keys', async (req: any, res: any) => {
  const { type } = req.body;
  const newKey = generateKey();
  let column = '';
  if (type === 'anon') column = 'anon_key';
  else if (type === 'service') column = 'service_key';
  else if (type === 'jwt') column = 'jwt_secret';
  else { res.status(400).json({ error: 'Invalid key type' }); return; }
  try {
    await systemPool.query(`UPDATE system.projects SET ${column} = $1 WHERE slug = $2`, [newKey, req.params.slug]);
    res.json({ success: true, type, newKey: 'HIDDEN_IN_RESPONSE' });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/control/projects/:slug/block-ip', async (req: any, res: any) => {
  const { ip } = req.body;
  try { await systemPool.query('UPDATE system.projects SET blocklist = array_append(blocklist, $1) WHERE slug = $2', [ip, req.params.slug]); res.json({ success: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/control/projects/:slug/blocklist/:ip', async (req: any, res: any) => {
  const { ip } = req.params;
  try { await systemPool.query('UPDATE system.projects SET blocklist = array_remove(blocklist, $1) WHERE slug = $2', [ip, req.params.slug]); res.json({ success: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/control/me/ip', (req: any, res: any) => {
  const forwarded = req.headers['x-forwarded-for'];
  const realIp = req.headers['x-real-ip'];
  const socketIp = req.socket.remoteAddress;
  let ip = (realIp as string) || (forwarded ? (forwarded as string).split(',')[0].trim() : socketIp) || '';
  res.json({ ip });
});

app.get('/api/control/projects/:slug/webhooks', async (req: any, res: any) => {
  try { const result = await systemPool.query('SELECT * FROM system.webhooks WHERE project_slug = $1', [req.params.slug]); res.json(result.rows); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/control/projects/:slug/webhooks', async (req: any, res: any) => {
  const { target_url, event_type, table_name } = req.body;
  try { await systemPool.query('INSERT INTO system.webhooks (project_slug, target_url, event_type, table_name) VALUES ($1, $2, $3, $4)', [req.params.slug, target_url, event_type, table_name]); res.json({ success: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/control/projects/:slug/logs', async (req: any, res: any) => {
  const { days } = req.query;
  try { await systemPool.query(`DELETE FROM system.api_logs WHERE project_slug = $1 AND created_at < now() - interval '${Number(days)} days'`, [req.params.slug]); res.json({ success: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/control/system/certificates/status', async (req: any, res: any) => {
  try { const status = await CertificateManager.detectEnvironment(); res.json(status); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/control/system/certificates', async (req: any, res: any) => {
  const { domain, email, cert, key, provider, isSystem } = req.body;
  try { const result = await CertificateManager.requestCertificate(domain, email, provider, { cert, key }, isSystem); res.json(result); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/control/system/certificates/:domain', async (req: any, res: any) => {
    try { await CertificateManager.deleteCertificate(req.params.domain); res.json({ success: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// --- DATA PLANE ROUTES ---

app.get('/api/data/:slug/stats', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try {
    const [tables, users, size] = await Promise.all([
      r.projectPool!.query("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE '_deleted_%'"),
      r.projectPool!.query("SELECT count(*) FROM auth.users"),
      r.projectPool!.query("SELECT pg_size_pretty(pg_database_size(current_database()))")
    ]);
    res.json({ tables: parseInt(tables.rows[0].count), users: parseInt(users.rows[0].count), size: size.rows[0].pg_size_pretty });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:slug/tables', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { const result = await r.projectPool!.query("SELECT table_name as name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE '_deleted_%'"); res.json(result.rows); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:slug/recycle-bin', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { const result = await r.projectPool!.query("SELECT table_name as name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE '_deleted_%'"); res.json(result.rows); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:slug/recycle-bin/:table/restore', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const tableName = req.params.table;
  try { const originalName = tableName.replace(/^_deleted_\d+_/, ''); await r.projectPool!.query(`ALTER TABLE public.${quoteId(tableName)} RENAME TO ${quoteId(originalName)}`); res.json({ success: true, restoredName: originalName }); } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/data/:slug/recycle-bin/:table', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { await r.projectPool!.query(`DROP TABLE public.${quoteId(req.params.table)} CASCADE`); res.json({ success: true }); } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get('/api/data/:slug/tables/:table/sql', async (req: any, res: any) => {
    const r = req as CascataRequest;
    const { table } = req.params;
    try {
        const columnsRes = await r.projectPool!.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1`, [table]);
        if (columnsRes.rowCount === 0) { res.json({ sql: `-- Table ${table} not found` }); return; }
        let sql = `CREATE TABLE public."${table}" (\n`;
        const cols = columnsRes.rows.map(c => `  "${c.column_name}" ${c.data_type.toUpperCase()}${c.is_nullable === 'NO' ? ' NOT NULL' : ''}${c.column_default ? ` DEFAULT ${c.column_default}` : ''}`);
        sql += cols.join(',\n') + '\n);';
        res.json({ sql });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:slug/tables', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { name, columns } = req.body;
  const colsSql = columns.map((c: any) => {
    let def = `${quoteId(c.name)} ${c.type}`;
    if (c.primaryKey) def += ' PRIMARY KEY';
    if (c.nullable === false) def += ' NOT NULL';
    if (c.isUnique) def += ' UNIQUE'; 
    if (c.default) def += ` DEFAULT ${c.default}`;
    if (c.foreignKey) def += ` REFERENCES public.${quoteId(c.foreignKey.table)}(${quoteId(c.foreignKey.column)})`;
    return def;
  }).join(', ');
  try {
    await r.projectPool!.query(`CREATE TABLE public.${quoteId(name)} (${colsSql})`);
    await r.projectPool!.query(`ALTER TABLE public.${quoteId(name)} ENABLE ROW LEVEL SECURITY`);
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post('/api/data/:slug/tables/:table/columns', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { name, type, isNullable, defaultValue, isUnique } = req.body;
  let sql = `ALTER TABLE public.${quoteId(req.params.table)} ADD COLUMN ${quoteId(name)} ${type}`;
  if (!isNullable) sql += ' NOT NULL';
  if (defaultValue) sql += ` DEFAULT ${defaultValue}`;
  if (isUnique) sql += ' UNIQUE';
  try { await r.projectPool!.query(sql); res.json({ success: true }); } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/data/:slug/tables/:table/rename', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { await r.projectPool!.query(`ALTER TABLE public.${quoteId(req.params.table)} RENAME TO ${quoteId(req.body.newName)}`); res.json({ success: true }); } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post('/api/data/:slug/tables/:table/duplicate', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { newName, withData } = req.body;
  try {
    await r.projectPool!.query(`CREATE TABLE public.${quoteId(newName)} AS TABLE public.${quoteId(req.params.table)} ${withData ? '' : 'WITH NO DATA'}`);
    await r.projectPool!.query(`ALTER TABLE public.${quoteId(newName)} ENABLE ROW LEVEL SECURITY`);
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/data/:slug/tables/:table', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { mode } = req.body;
  try {
    if (mode === 'CASCADE' || mode === 'RESTRICT') await r.projectPool!.query(`DROP TABLE public.${quoteId(req.params.table)} ${mode === 'CASCADE' ? 'CASCADE' : ''}`);
    else await r.projectPool!.query(`ALTER TABLE public.${quoteId(req.params.table)} RENAME TO ${quoteId(`_deleted_${Date.now()}_${req.params.table}`)}`);
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get('/api/data/:slug/tables/:table/columns', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try {
    const result = await r.projectPool!.query(`SELECT column_name as name, data_type as type, is_nullable = 'YES' as "isNullable", EXISTS (SELECT 1 FROM information_schema.key_column_usage kcu WHERE kcu.table_name = $1 AND kcu.column_name = c.column_name) as "isPrimaryKey" FROM information_schema.columns c WHERE table_name = $1`, [req.params.table]);
    res.json(result.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:slug/tables/:table/rows', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { data } = req.body;
  const rows = Array.isArray(data) ? data : [data];
  if (rows.length === 0) { res.json([]); return; }
  try {
    const resultRows = await queryWithRLS(r, async (client) => {
        let allResults = [];
        await client.query('BEGIN');
        for (const row of rows) {
            const keys = Object.keys(row);
            if (keys.length === 0) continue;
            const cols = keys.map(k => quoteId(k)).join(',');
            const values = keys.map(k => row[k]);
            const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
            const res = await client.query(`INSERT INTO public.${quoteId(req.params.table)} (${cols}) VALUES (${placeholders}) RETURNING *`, values);
            allResults.push(res.rows[0]);
        }
        await client.query('COMMIT');
        return allResults;
    });
    res.json(Array.isArray(data) ? resultRows : resultRows[0]);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get('/api/data/:slug/tables/:table/data', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { select, limit = 100 } = req.query;
  const cols = (typeof select === 'string' && select !== '*') ? select.split(',').map(c => quoteId(c.trim())).join(',') : '*';
  try {
    const rows = await queryWithRLS(r, async (client) => {
        const result = await client.query(`SELECT ${cols} FROM public.${quoteId(req.params.table)} LIMIT $1`, [limit]);
        return result.rows;
    });
    res.json(rows);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.put('/api/data/:slug/tables/:table/rows', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { data, pkColumn, pkValue } = req.body;
  const keys = Object.keys(data).filter(k => k !== pkColumn);
  const setClause = keys.map((k, i) => `${quoteId(k)} = $${i + 1}`).join(', ');
  const values = [...keys.map(k => data[k]), pkValue];
  try {
    await queryWithRLS(r, async (client) => {
        await client.query(`UPDATE public.${quoteId(req.params.table)} SET ${setClause} WHERE ${quoteId(pkColumn)} = $${values.length}`, values);
    });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post('/api/data/:slug/tables/:table/delete-rows', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { ids, pkColumn } = req.body;
  try {
    await queryWithRLS(r, async (client) => {
        await client.query(`DELETE FROM public.${quoteId(req.params.table)} WHERE ${quoteId(pkColumn)} = ANY($1)`, [ids]);
    });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post('/api/data/:slug/query', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { sql } = req.body;
  if (r.userRole !== 'service_role') { res.status(403).json({ error: 'Only Service Role can execute raw SQL' }); return; }
  const start = Date.now();
  try {
    const result = await r.projectPool!.query(sql);
    res.json({ rows: result.rows, rowCount: result.rowCount, command: result.command, duration: Date.now() - start });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post('/api/data/:slug/rpc/:name', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const params = req.body || {};
  const placeholders = Object.keys(params).map((_, i) => `$${i + 1}`).join(', ');
  const values = Object.values(params);
  try {
    const rows = await queryWithRLS(r, async (client) => {
        const result = await client.query(`SELECT * FROM public.${quoteId(req.params.name)}(${placeholders})`, values);
        return result.rows;
    });
    res.json(rows);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get('/api/data/:slug/auth/users', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { const result = await r.projectPool!.query(`SELECT u.id, u.created_at, u.banned, u.last_sign_in_at, jsonb_agg(jsonb_build_object('id', i.id, 'provider', i.provider, 'identifier', i.identifier)) as identities FROM auth.users u LEFT JOIN auth.identities i ON u.id = i.user_id GROUP BY u.id ORDER BY u.created_at DESC`); res.json(result.rows); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:slug/auth/users', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { strategies, profileData } = req.body; 
  const client = await r.projectPool!.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query('INSERT INTO auth.users (raw_user_meta_data) VALUES ($1) RETURNING id', [profileData || {}]);
    const userId = userRes.rows[0].id;
    if (strategies) { for (const s of strategies) await client.query('INSERT INTO auth.identities (user_id, provider, identifier, password_hash) VALUES ($1, $2, $3, $4)', [userId, s.provider, s.identifier, s.password]); }
    await client.query('COMMIT');
    res.json({ success: true, id: userId });
  } catch (e: any) { await client.query('ROLLBACK'); res.status(400).json({ error: e.message }); } finally { client.release(); }
});

app.patch('/api/data/:slug/auth/users/:id/status', async (req: any, res: any) => {
    const r = req as CascataRequest;
    try { await r.projectPool!.query('UPDATE auth.users SET banned = $1 WHERE id = $2', [req.body.banned, req.params.id]); res.json({ success: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/data/:slug/auth/users/:id', async (req: any, res: any) => {
    const r = req as CascataRequest;
    try { await r.projectPool!.query('DELETE FROM auth.users WHERE id = $1', [req.params.id]); res.json({ success: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:slug/auth/token', async (req: any, res: any) => {
    const r = req as CascataRequest;
    const { provider, identifier, password } = req.body;
    try {
        const idRes = await r.projectPool!.query('SELECT * FROM auth.identities WHERE provider = $1 AND identifier = $2', [provider, identifier]);
        if (!idRes.rows[0] || idRes.rows[0].password_hash !== password) { res.status(401).json({ error: 'Invalid credentials' }); return; }
        const userId = idRes.rows[0].user_id;
        const token = jwt.sign({ sub: userId, role: 'authenticated' }, r.project.jwt_secret, { expiresIn: '24h' });
        res.json({ access_token: token, token_type: 'bearer', user: { id: userId } });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:slug/auth/link', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { linked_tables } = req.body;
  try {
    await systemPool.query(`UPDATE system.projects SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE slug = $2`, [JSON.stringify(req.body), r.project.slug]);
    if (linked_tables && Array.isArray(linked_tables) && linked_tables.length > 0) {
        const client = await r.projectPool!.connect();
        try {
            await client.query('BEGIN');
            for (const table of linked_tables) {
                await client.query(`ALTER TABLE public.${quoteId(table)} ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL`);
                await client.query(`CREATE INDEX IF NOT EXISTS ${quoteId('idx_' + table + '_user_id')} ON public.${quoteId(table)} (user_id)`);
            }
            await client.query('COMMIT');
        } catch (dbErr: any) { await client.query('ROLLBACK'); console.error("Link Table Error:", dbErr); } finally { client.release(); }
    }
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

const walk = (dir: string, rootPath: string, fileList: any[] = []) => {
  try {
    const files = fs.readdirSync(dir);
    files.forEach((file) => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
      fileList.push({ name: file, type: stat.isDirectory() ? 'folder' : 'file', size: stat.size, updated_at: stat.mtime.toISOString(), path: relativePath });
      if (stat.isDirectory()) walk(filePath, rootPath, fileList);
    });
  } catch (e) {}
  return fileList;
};

app.get('/api/data/:slug/storage/search', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { q, bucket } = req.query;
  const searchTerm = (q as string || '').toLowerCase();
  const projectRoot = path.join(STORAGE_ROOT, r.project.slug);
  const searchRoot = bucket ? path.join(projectRoot, bucket as string) : projectRoot;
  if (!fs.existsSync(searchRoot)) { res.json({ items: [] }); return; }
  if (!searchRoot.startsWith(projectRoot)) { res.status(403).json({ error: 'Access Denied' }); return; }
  try {
    let allFiles = walk(searchRoot, bucket ? searchRoot : projectRoot, []);
    if (searchTerm) allFiles = allFiles.filter(f => f.name.toLowerCase().includes(searchTerm));
    res.json({ items: allFiles });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:slug/storage/buckets', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const p = path.join(STORAGE_ROOT, r.project.slug);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  const items = fs.readdirSync(p).filter(f => fs.lstatSync(path.join(p, f)).isDirectory());
  res.json(items.map(name => ({ name })));
});

app.post('/api/data/:slug/storage/buckets', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const p = path.join(STORAGE_ROOT, r.project.slug, req.body.name);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  res.json({ success: true });
});

app.patch('/api/data/:slug/storage/buckets/:name', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const oldPath = path.join(STORAGE_ROOT, r.project.slug, req.params.name);
  const newPath = path.join(STORAGE_ROOT, r.project.slug, req.body.newName);
  if (!fs.existsSync(oldPath)) { res.status(404).json({ error: 'Bucket not found' }); return; }
  if (fs.existsSync(newPath)) { res.status(400).json({ error: 'Name already exists' }); return; }
  fs.renameSync(oldPath, newPath);
  res.json({ success: true });
});

app.delete('/api/data/:slug/storage/buckets/:name', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const bucketPath = path.join(STORAGE_ROOT, r.project.slug, req.params.name);
  if (!fs.existsSync(bucketPath)) { res.status(404).json({ error: 'Bucket not found' }); return; }
  if (!bucketPath.startsWith(path.join(STORAGE_ROOT, r.project.slug))) { res.status(403).json({ error: 'Access denied' }); return; }
  try { fs.rmSync(bucketPath, { recursive: true, force: true }); res.json({ success: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:slug/storage/:bucket/folder', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { name, path: relativePath } = req.body;
  const bucketPath = path.join(STORAGE_ROOT, r.project.slug, req.params.bucket);
  const folderPath = path.join(bucketPath, relativePath || '', name);
  if (!folderPath.startsWith(bucketPath)) { res.status(403).json({ error: 'Access Denied' }); return; }
  if (!fs.existsSync(folderPath)) { fs.mkdirSync(folderPath, { recursive: true }); res.json({ success: true }); } else { res.status(400).json({ error: 'Folder exists' }); }
});

app.get('/api/data/:slug/storage/:bucket/list', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { path: queryPath } = req.query;
  const bucketPath = path.join(STORAGE_ROOT, r.project.slug, req.params.bucket);
  const targetPath = path.join(bucketPath, (queryPath as string) || '');
  if (!targetPath.startsWith(bucketPath)) { res.status(403).json({ error: 'Access Denied' }); return; }
  if (!fs.existsSync(targetPath)) { res.json({ items: [] }); return; }
  try {
    const files = fs.readdirSync(targetPath);
    const items = files.map(file => {
      const filePath = path.join(targetPath, file);
      const stat = fs.statSync(filePath);
      return { name: file, type: stat.isDirectory() ? 'folder' : 'file', size: stat.size, updated_at: stat.mtime.toISOString(), path: path.relative(bucketPath, filePath).replace(/\\/g, '/') };
    });
    res.json({ items });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:slug/storage/:bucket/object/*', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const relativePath = req.params[0]; 
  const bucketPath = path.join(STORAGE_ROOT, r.project.slug, req.params.bucket);
  const filePath = path.join(bucketPath, relativePath);
  if (!filePath.startsWith(bucketPath)) { res.status(403).json({ error: 'Path Traversal Detected' }); return; }
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File Not Found' }); return; }
  res.sendFile(filePath);
});

app.post('/api/data/:slug/storage/:bucket/upload', upload.single('file') as any, async (req: any, res: any) => {
  const r = req as CascataRequest;
  if (!r.file) { res.status(400).json({ error: 'No file found in request' }); return; }
  const governance = r.project.metadata?.storage_governance || {};
  const ext = path.extname(r.file.originalname).replace('.', '').toLowerCase();
  const sector = getSectorForExt(ext);
  const rule = governance[sector] || governance['global'] || { max_size: '10MB', allowed_exts: [] };
  if (rule.allowed_exts && !rule.allowed_exts.includes(ext)) { fs.unlinkSync(r.file.path); res.status(403).json({ error: `Policy Violation: Extension .${ext} is not allowed.` }); return; }
  const maxBytes = parseBytes(rule.max_size);
  if (r.file.size > maxBytes) { fs.unlinkSync(r.file.path); res.status(403).json({ error: `Policy Violation: File size exceeds limit.` }); return; }
  const dest = path.join(STORAGE_ROOT, r.project.slug, req.params.bucket, r.body.path || '', r.file.originalname);
  if (!fs.existsSync(path.dirname(dest))) fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(r.file.path, dest);
  res.json({ success: true });
});

app.post('/api/data/:slug/storage/move', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { bucket, paths, destination } = req.body; 
  const root = path.join(STORAGE_ROOT, r.project.slug);
  const destPath = path.join(root, destination.bucket || bucket, destination.path || '');
  if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
  let movedCount = 0;
  for (const itemPath of paths) {
      const source = path.join(root, bucket, itemPath);
      const itemName = path.basename(itemPath);
      const target = path.join(destPath, itemName);
      if (fs.existsSync(source)) { fs.renameSync(source, target); movedCount++; }
  }
  res.json({ success: true, moved: movedCount });
});

app.delete('/api/data/:slug/storage/:bucket/object', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { path: queryPath } = req.query;
  const filePath = path.join(STORAGE_ROOT, r.project.slug, req.params.bucket, (queryPath as string));
  if (fs.existsSync(filePath)) { fs.rmSync(filePath, { recursive: true, force: true }); res.json({ success: true }); } else { res.status(404).json({ error: 'Not found' }); }
});

app.get('/api/data/:slug/logs', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { const result = await systemPool.query('SELECT * FROM system.api_logs WHERE project_slug = $1 ORDER BY created_at DESC LIMIT 100', [r.project.slug]); res.json(result.rows); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:slug/assets', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { const result = await systemPool.query('SELECT * FROM system.assets WHERE project_slug = $1', [r.project.slug]); res.json(result.rows); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:slug/assets', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { id, name, type, parent_id, metadata } = req.body;
  try {
    if (id) { const upd = await systemPool.query('UPDATE system.assets SET name=$1, metadata=$2 WHERE id=$3 RETURNING *', [name, metadata, id]); res.json(upd.rows[0]); } 
    else { const ins = await systemPool.query('INSERT INTO system.assets (project_slug, name, type, parent_id, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING *', [r.project.slug, name, type, parent_id, metadata]); res.json(ins.rows[0]); }
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/data/:slug/assets/:id', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { await systemPool.query('DELETE FROM system.assets WHERE id=$1', [req.params.id]); res.json({ success: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:slug/policies', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { const result = await r.projectPool!.query("SELECT * FROM pg_policies"); res.json(result.rows); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:slug/policies', async (req: any, res: any) => {
  const r = req as CascataRequest;
  const { name, table, command, role, using, withCheck } = req.body;
  const sql = `CREATE POLICY ${quoteId(name)} ON public.${quoteId(table)} FOR ${command} TO ${role} USING (${using}) ${withCheck ? `WITH CHECK (${withCheck})` : ''}`;
  try { await r.projectPool!.query(sql); res.json({ success: true }); } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/data/:slug/policies/:table/:name', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { await r.projectPool!.query(`DROP POLICY ${quoteId(req.params.name)} ON public.${quoteId(req.params.table)}`); res.json({ success: true }); } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get('/api/data/:slug/functions', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { const result = await r.projectPool!.query(`SELECT routine_name as name FROM information_schema.routines WHERE routine_schema = 'public'`); res.json(result.rows); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:slug/triggers', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { const result = await r.projectPool!.query(`SELECT trigger_name as name FROM information_schema.triggers`); res.json(result.rows); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/data/:slug/ui-settings/:table', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { const result = await systemPool.query('SELECT settings FROM system.ui_settings WHERE project_slug = $1 AND table_name = $2', [r.project.slug, req.params.table]); res.json(result.rows[0]?.settings || {}); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data/:slug/ui-settings/:table', async (req: any, res: any) => {
  const r = req as CascataRequest;
  try { await systemPool.query(`INSERT INTO system.ui_settings (project_slug, table_name, settings) VALUES ($1, $2, $3) ON CONFLICT (project_slug, table_name) DO UPDATE SET settings = $3`, [r.project.slug, req.params.table, req.body.settings]); res.json({ success: true }); } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// STARTUP
(async () => {
  try {
    console.log('[System] Initializing Cascata Backend...');
    await CertificateManager.ensureSystemCert();
    app.listen(PORT, () => console.log(`[CASCATA SECURE ENGINE] v5.5 Listening on port ${PORT}`));
    const dbReady = await waitForDatabase(15, 3000); 
    if (dbReady) await MigrationRunner.run();
  } catch (e) { console.error('[System] FATAL ERROR during startup:', e); }
})();
