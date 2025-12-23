
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Pool } from 'pg';
import { exec } from 'child_process';
import util from 'util';
import { fileURLToPath } from 'url';

const execAsync = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APPS_ROOT = path.resolve(__dirname, '../../storage/apps');

// Repositório Oficial de Apps
const GITHUB_REPO_BASE = 'https://raw.githubusercontent.com/supermetanet-png/cascata-apps/main';

export class AppStore {
    private systemPool: Pool;

    constructor(pool: Pool) {
        this.systemPool = pool;
        if (!fs.existsSync(APPS_ROOT)) fs.mkdirSync(APPS_ROOT, { recursive: true });
    }

    // --- 1. LISTAGEM (ONLINE ONLY) ---
    public async fetchStoreListing() {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        
        try {
            const res = await fetch(`${GITHUB_REPO_BASE}/apps.json`, { signal: controller.signal });
            clearTimeout(timeout);
            
            if (!res.ok) throw new Error(`Falha ao contactar App Store (HTTP ${res.status})`);
            return await res.json();
        } catch (e: any) {
            clearTimeout(timeout);
            console.error("[AppStore] Fetch error:", e.message);
            throw new Error("Não foi possível carregar o catálogo de apps. Verifique sua conexão com a internet.");
        }
    }

    // --- 2. INSTALAÇÃO (ROBUST DEPLOY WITH .ENV) ---
    public async installApp(projectSlug: string, appId: string, domain: string) {
        // 1. Validação de Duplicidade de Domínio
        const cleanDomain = domain.trim().toLowerCase();
        const check = await this.systemPool.query(
            `SELECT id FROM system.apps WHERE domain = $1`, 
            [cleanDomain]
        );
        
        if (check.rowCount && check.rowCount > 0) {
            throw new Error(`O domínio '${cleanDomain}' já está em uso por outra aplicação.`);
        }

        // 2. Validação de Conflito com Projetos
        const checkProj = await this.systemPool.query(
            `SELECT id FROM system.projects WHERE custom_domain = $1`, 
            [cleanDomain]
        );
        if (checkProj.rowCount && checkProj.rowCount > 0) {
            throw new Error(`O domínio '${cleanDomain}' já está em uso por um Projeto.`);
        }

        console.log(`[AppStore] Installing ${appId} for ${projectSlug} on ${cleanDomain}...`);

        const deployId = crypto.randomUUID();
        const shortId = deployId.split('-')[0];
        
        // Configuração de Banco de Dados Isolado
        const dbName = `app_${projectSlug.replace(/-/g,'_')}_${appId}_${shortId}`.toLowerCase();
        const dbUser = `u_${shortId}`;
        const dbPass = crypto.randomBytes(16).toString('hex');
        
        // Credenciais
        const encryptionKey = crypto.randomBytes(32).toString('base64'); 
        const runnerSecret = crypto.randomBytes(32).toString('base64');
        const jwtSecret = crypto.randomBytes(32).toString('hex');

        // A. Provisionar Banco de Dados no Postgres do Sistema
        const client = await this.systemPool.connect();
        try {
            const userCheck = await client.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [dbUser]);
            if (userCheck.rowCount === 0) {
                await client.query(`CREATE USER "${dbUser}" WITH PASSWORD '${dbPass}'`);
            }
            await client.query(`CREATE DATABASE "${dbName}" OWNER "${dbUser}"`);
        } catch (e: any) {
            client.release();
            throw new Error(`Falha ao provisionar banco: ${e.message}`);
        } finally {
            client.release();
        }

        // B. Obter Template Docker Compose
        let composeTemplate = '';
        try {
            const res = await fetch(`${GITHUB_REPO_BASE}/${appId}/docker-compose.yml`);
            if (res.ok) {
                composeTemplate = await res.text();
            } else {
                throw new Error("Template docker-compose.yml não encontrado no repositório.");
            }
        } catch (e: any) {
            throw new Error(`Erro ao baixar template: ${e.message}`);
        }

        // C. Preparar Variáveis (.ENV e Replace)
        const networkName = await this.getDockerNetworkName();
        const containerPrefix = `app-${shortId}`;
        
        // Mapeamento exaustivo para cobrir diferentes padrões de template
        const vars: Record<string, string> = {
            CONTAINER_PREFIX: containerPrefix,
            DOMAIN: cleanDomain,
            SUBDOMAIN: cleanDomain.split('.')[0],
            NETWORK_NAME: networkName,
            
            // Database Standard
            DB_HOST: 'cascata-db',
            DB_PORT: '5432',
            DB_NAME: dbName,
            DB_USER: dbUser,
            DB_PASS: dbPass,
            
            // Postgres Specific
            POSTGRES_DB: dbName,
            POSTGRES_USER: dbUser,
            POSTGRES_PASSWORD: dbPass,
            
            // Secrets & Keys
            ENCRYPTION_KEY: encryptionKey,
            JWT_SECRET: jwtSecret,
            
            // N8N Critical Secrets (Correção do erro "missing value")
            RUNNER_SECRET: runnerSecret, 
            N8N_RUNNERS_SECRET: runnerSecret, // Variável obrigatória para N8N v1+ distributed
            
            // N8N Specifics
            N8N_ENCRYPTION_KEY: encryptionKey,
            N8N_USER_MANAGEMENT_JWT_SECRET: jwtSecret,
            N8N_HOST: cleanDomain,
            N8N_PORT: '5678',
            N8N_PROTOCOL: 'https',
            WEBHOOK_URL: `https://${cleanDomain}/`,
            PROXY_HOPS: '1', // Correção do warning: Indica que há 1 proxy (Nginx) na frente
            
            // Generic
            TZ: 'UTC',
            GENERIC_TIMEZONE: 'UTC'
        };

        // Replace placeholders in file (Legacy support for templates using ${VAR})
        let finalCompose = composeTemplate;
        for (const [key, val] of Object.entries(vars)) {
            const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
            finalCompose = finalCompose.replace(regex, val);
        }

        // D. Salvar Arquivos
        const appDir = path.join(APPS_ROOT, deployId);
        if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
        
        fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), finalCompose);
        
        // CRÍTICO: Gerar arquivo .env para que o docker-compose pegue as variáveis
        // que não foram substituídas diretamente no YAML (interpolação nativa)
        const envContent = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n');
        fs.writeFileSync(path.join(appDir, '.env'), envContent);
        
        // E. Registrar no Banco
        const envVarsForDb = {
            DB_NAME: dbName,
            DB_USER: dbUser,
            DB_HOST: 'cascata-db',
            INSTALL_DATE: new Date().toISOString()
        };

        await this.systemPool.query(
            `INSERT INTO system.apps (id, project_slug, type, domain, port_internal, container_name_main, env_vars, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'provisioning')`,
            [deployId, projectSlug, appId, cleanDomain, 5678, `${containerPrefix}-main`, JSON.stringify(envVarsForDb)]
        );

        // F. Executar Deploy (Usando CWD para pegar o .env)
        try {
            // Executa no diretório do app para garantir que o .env seja lido
            // Usamos docker-compose (hifenizado) para compatibilidade Alpine se instalado via pip/pkg
            await execAsync(`docker-compose up -d`, { cwd: appDir });
            await this.systemPool.query(`UPDATE system.apps SET status = 'running' WHERE id = $1`, [deployId]);
            return { success: true, id: deployId };
        } catch (e: any) {
            console.error("[AppStore] Docker Deploy Failed:", e);
            await this.systemPool.query(`UPDATE system.apps SET status = 'error' WHERE id = $1`, [deployId]);
            // Manter registro para debug, mas lançar erro
            throw new Error(`Comando Docker falhou (Verifique logs): ${e.message}`);
        }
    }

    public async stopApp(appId: string) {
        const appDir = path.join(APPS_ROOT, appId);
        if (fs.existsSync(path.join(appDir, 'docker-compose.yml'))) {
            try {
                await execAsync(`docker-compose down`, { cwd: appDir });
            } catch (e) {
                console.warn(`[AppStore] Warning on stop: ${e}`);
            }
        }
        await this.systemPool.query(`UPDATE system.apps SET status = 'stopped' WHERE id = $1`, [appId]);
    }

    public async startApp(appId: string) {
        const appDir = path.join(APPS_ROOT, appId);
        if (fs.existsSync(path.join(appDir, 'docker-compose.yml'))) {
            await execAsync(`docker-compose up -d`, { cwd: appDir });
        } else {
            throw new Error("Arquivos da aplicação não encontrados.");
        }
        await this.systemPool.query(`UPDATE system.apps SET status = 'running' WHERE id = $1`, [appId]);
    }

    // --- ROBUST DELETE (PREVINE ERRO 500) ---
    public async deleteApp(appId: string) {
        console.log(`[AppStore] Deleting app ${appId}...`);
        const appDir = path.join(APPS_ROOT, appId);
        
        // 1. Tentar derrubar containers
        if (fs.existsSync(path.join(appDir, 'docker-compose.yml'))) {
            try {
                // Usar cwd para garantir que variáveis do .env (como network names) sejam resolvidas
                await execAsync(`docker-compose down -v`, { cwd: appDir });
            } catch (e: any) {
                console.warn(`[AppStore] Docker down failed (ignoring cleanup): ${e.message}`);
            }
        }

        // 2. Tentar remover banco de dados (Best Effort)
        try {
            const res = await this.systemPool.query(`SELECT env_vars FROM system.apps WHERE id = $1`, [appId]);
            if (res.rows.length > 0) {
                const env = res.rows[0].env_vars;
                if (env && env.DB_NAME) {
                    await this.systemPool.query(`DROP DATABASE IF EXISTS "${env.DB_NAME}"`);
                    await this.systemPool.query(`DROP USER IF EXISTS "${env.DB_USER}"`);
                }
            }
        } catch (e) {
            console.warn(`[AppStore] DB Cleanup failed:`, e);
        }

        // 3. Remover registro do banco
        await this.systemPool.query(`DELETE FROM system.apps WHERE id = $1`, [appId]);
        
        // 4. Remover arquivos
        if (fs.existsSync(appDir)) {
            try {
                fs.rmSync(appDir, { recursive: true, force: true });
            } catch (e) {
                console.warn(`[AppStore] File cleanup failed:`, e);
            }
        }
    }

    public async getLogs(appId: string, lines: number = 200) {
        const res = await this.systemPool.query(`SELECT container_name_main FROM system.apps WHERE id = $1`, [appId]);
        if (res.rows.length === 0) throw new Error("App not found");
        const container = res.rows[0].container_name_main;
        try {
            const { stdout } = await execAsync(`docker logs --tail ${lines} ${container}`);
            return stdout;
        } catch (e) {
            return "Container not running or logs unavailable.";
        }
    }

    private async getDockerNetworkName(): Promise<string> {
        try {
            const containerName = process.env.NGINX_CONTAINER_NAME || 'cascata-nginx';
            const { stdout } = await execAsync(`docker inspect ${containerName} --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}'`);
            return stdout.trim() || 'bridge';
        } catch (e) {
            return 'default';
        }
    }
}
