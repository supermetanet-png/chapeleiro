
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

    // --- 1. LISTAGEM (GITHUB SOURCE OF TRUTH) ---
    public async fetchStoreListing() {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            
            const res = await fetch(`${GITHUB_REPO_BASE}/apps.json`, { signal: controller.signal });
            clearTimeout(timeout);
            
            if (!res.ok) throw new Error("Repositório inacessível");
            return await res.json();
        } catch (e) {
            console.warn("[AppStore] GitHub fetch failed, using offline fallback:", e);
            return [
                {
                    id: "n8n",
                    name: "n8n Workflow Automation",
                    description: "Ferramenta de automação de fluxo de trabalho líder de mercado. (Modo Offline)",
                    logo: "https://raw.githubusercontent.com/n8n-io/n8n/master/assets/n8n-logo.png",
                    version: "latest",
                    tags: ["Automation", "Low-code", "Official"]
                }
            ];
        }
    }

    // --- 2. INSTALAÇÃO (SYSTEM DB SHARING) ---
    public async installApp(projectSlug: string, appId: string, domain: string) {
        console.log(`[AppStore] Installing ${appId} for ${projectSlug} on ${domain}...`);

        const deployId = crypto.randomUUID();
        const shortId = deployId.split('-')[0];
        
        // Configuração de Banco de Dados ISOLADO LÓGICAMENTE no Postgres do Sistema
        const dbName = `app_${projectSlug.replace(/-/g,'_')}_${appId}_${shortId}`.toLowerCase();
        const dbUser = `u_${shortId}`;
        const dbPass = crypto.randomBytes(16).toString('hex');
        
        // Credenciais Específicas do n8n (Geradas automaticamente)
        const encryptionKey = crypto.randomBytes(32).toString('base64'); 
        const runnerSecret = crypto.randomBytes(32).toString('base64');
        const jwtSecret = crypto.randomBytes(32).toString('hex');

        // A. Provisionar Banco de Dados
        const client = await this.systemPool.connect();
        try {
            // Verifica se usuário existe
            const userCheck = await client.query(`SELECT 1 FROM pg_roles WHERE rolname=$1`, [dbUser]);
            if (userCheck.rowCount === 0) {
                await client.query(`CREATE USER "${dbUser}" WITH PASSWORD '${dbPass}'`);
            }
            // Cria o banco
            await client.query(`CREATE DATABASE "${dbName}" OWNER "${dbUser}"`);
            console.log(`[AppStore] DB ${dbName} criado.`);
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
                throw new Error("Template remoto não encontrado");
            }
        } catch (e) {
            console.log("[AppStore] Using local fallback template for n8n");
            if (appId === 'n8n') composeTemplate = this.getN8nFallbackTemplate();
            else throw new Error("App não suportado no modo fallback.");
        }

        // C. Substituir Variáveis no Template
        const networkName = await this.getDockerNetworkName();
        const containerPrefix = `app-${shortId}`; 
        
        let finalCompose = composeTemplate
            .replace(/\${CONTAINER_PREFIX}/g, containerPrefix)
            .replace(/\${DOMAIN}/g, domain)
            .replace(/\${NETWORK_NAME}/g, networkName)
            .replace(/\${DB_HOST}/g, 'cascata-db') 
            .replace(/\${DB_NAME}/g, dbName)
            .replace(/\${DB_USER}/g, dbUser)
            .replace(/\${DB_PASS}/g, dbPass)
            .replace(/\${ENCRYPTION_KEY}/g, encryptionKey)
            .replace(/\${JWT_SECRET}/g, jwtSecret)
            .replace(/\${RUNNER_SECRET}/g, runnerSecret);

        // D. Salvar Arquivos
        const appDir = path.join(APPS_ROOT, deployId);
        if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
        fs.writeFileSync(path.join(appDir, 'docker-compose.yml'), finalCompose);
        
        // E. Registrar no Banco do Sistema
        const envVars = {
            DB_NAME: dbName,
            DB_USER: dbUser,
            DB_HOST: 'cascata-db',
            N8N_ENCRYPTION_KEY: encryptionKey, 
            INSTALL_DATE: new Date().toISOString()
        };

        await this.systemPool.query(
            `INSERT INTO system.apps (id, project_slug, type, domain, port_internal, container_name_main, env_vars, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'provisioning')`,
            [deployId, projectSlug, appId, domain, 5678, `${containerPrefix}-main`, JSON.stringify(envVars)]
        );

        // F. Executar Deploy
        try {
            await execAsync(`docker compose -f ${path.join(appDir, 'docker-compose.yml')} up -d`);
            await this.systemPool.query(`UPDATE system.apps SET status = 'running' WHERE id = $1`, [deployId]);
            return { success: true, id: deployId };
        } catch (e: any) {
            console.error("[AppStore] Docker Deploy Failed:", e);
            await this.systemPool.query(`UPDATE system.apps SET status = 'error' WHERE id = $1`, [deployId]);
            throw new Error(`Deploy Docker falhou: ${e.message}`);
        }
    }

    public async stopApp(appId: string) {
        const appDir = path.join(APPS_ROOT, appId);
        if (fs.existsSync(path.join(appDir, 'docker-compose.yml'))) {
            await execAsync(`docker compose -f ${path.join(appDir, 'docker-compose.yml')} down`);
        }
        await this.systemPool.query(`UPDATE system.apps SET status = 'stopped' WHERE id = $1`, [appId]);
    }

    public async startApp(appId: string) {
        const appDir = path.join(APPS_ROOT, appId);
        if (fs.existsSync(path.join(appDir, 'docker-compose.yml'))) {
            await execAsync(`docker compose -f ${path.join(appDir, 'docker-compose.yml')} up -d`);
        }
        await this.systemPool.query(`UPDATE system.apps SET status = 'running' WHERE id = $1`, [appId]);
    }

    public async deleteApp(appId: string) {
        await this.stopApp(appId);
        await this.systemPool.query(`DELETE FROM system.apps WHERE id = $1`, [appId]);
        const appDir = path.join(APPS_ROOT, appId);
        if (fs.existsSync(appDir)) {
            fs.rmSync(appDir, { recursive: true, force: true });
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

    private getN8nFallbackTemplate() {
        return `
services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    container_name: \${CONTAINER_PREFIX}-main
    networks:
      - default
      - cascata_net
    environment:
      - NODE_ENV=production
      - N8N_HOST=\${DOMAIN}
      - N8N_PORT=5678
      - N8N_PROTOCOL=https
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=\${DB_HOST}
      - DB_POSTGRESDB_PORT=5432
      - DB_POSTGRESDB_USER=\${DB_USER}
      - DB_POSTGRESDB_PASSWORD=\${DB_PASS}
      - DB_POSTGRESDB_DATABASE=\${DB_NAME}
      - N8N_ENCRYPTION_KEY=\${ENCRYPTION_KEY}
      - N8N_USER_MANAGEMENT_JWT_SECRET=\${JWT_SECRET}
      - WEBHOOK_URL=https://\${DOMAIN}/
      - N8N_PROXY_HOPS=1
      - GENERIC_TIMEZONE=America/Sao_Paulo
    volumes:
      - ./n8n_data:/home/node/.n8n

networks:
  cascata_net:
    internal: true
  default:
    name: \${NETWORK_NAME}
    external: true
`;
    }
}
