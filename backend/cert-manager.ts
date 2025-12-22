
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export type CertProvider = 'traefik' | 'certbot' | 'manual' | 'none';

interface CertStatus {
  provider: CertProvider;
  active: boolean;
  domains: string[];
  message: string;
}

export class CertificateManager {
  // O volume 'certs' do docker-compose mapeia para /etc/letsencrypt
  private static basePath = '/etc/letsencrypt/live'; 
  private static archivePath = '/etc/letsencrypt/archive'; 
  private static webrootPath = '/var/www/html'; // Compartilhado com Nginx para desafio ACME

  /**
   * Sanitiza o domínio para evitar Path Traversal e Command Injection.
   * Permite apenas letras, números, hífens e pontos.
   */
  private static validateDomain(domain: string): boolean {
    const regex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z]{2,})+$/;
    return regex.test(domain) && !domain.includes('..');
  }

  public static async detectEnvironment(): Promise<CertStatus> {
    const domains: string[] = [];
    
    if (fs.existsSync(this.basePath)) {
      try {
        const dirs = fs.readdirSync(this.basePath).filter(f => 
          fs.lstatSync(path.join(this.basePath, f)).isDirectory()
        );
        domains.push(...dirs);
      } catch (e) {
        console.error("Error scanning certs dir:", e);
      }
    }

    // Verifica se tem certbot instalado
    const hasCertbot = fs.existsSync('/usr/bin/certbot') || fs.existsSync('/usr/local/bin/certbot');

    return {
      provider: hasCertbot ? 'certbot' : 'manual',
      active: domains.length > 0,
      domains,
      message: `${domains.length} domínios configurados.`
    };
  }

  /**
   * Salva certificados manuais (ex: Cloudflare Origin CA)
   * Simula a estrutura do Certbot para que o Nginx não precise mudar a configuração.
   */
  public static async provisionManual(domain: string, certContent: string, keyContent: string): Promise<{ success: boolean, message: string }> {
    if (!this.validateDomain(domain)) {
      throw new Error("Domínio inválido ou inseguro.");
    }

    const domainDir = path.join(this.basePath, domain);
    
    try {
      if (!fs.existsSync(domainDir)) {
        fs.mkdirSync(domainDir, { recursive: true });
      }

      // Escreve fullchain.pem e privkey.pem
      fs.writeFileSync(path.join(domainDir, 'fullchain.pem'), certContent.trim());
      fs.writeFileSync(path.join(domainDir, 'privkey.pem'), keyContent.trim());
      
      // Cria arquivo de teste para validar
      fs.writeFileSync(path.join(domainDir, 'README.txt'), `Managed manually via Cascata Control Plane at ${new Date().toISOString()}`);

      return { success: true, message: `Certificados manuais salvos em ${domainDir}. Reinicie o Nginx para aplicar.` };
    } catch (e: any) {
      console.error(`[Manual SSL Error]`, e);
      throw new Error(`Falha ao escrever arquivos: ${e.message}`);
    }
  }

  /**
   * Executa o Certbot de forma segura usando spawn (sem shell)
   */
  public static async provisionCertbot(domain: string, email: string): Promise<{ success: boolean, message: string }> {
    if (!this.validateDomain(domain)) {
      throw new Error("Domínio inválido ou inseguro.");
    }
    if (!email.includes('@')) {
      throw new Error("Email inválido para registro ACME.");
    }

    return new Promise((resolve, reject) => {
      console.log(`[CertManager] Iniciando Certbot para ${domain}...`);

      // Spawn evita Shell Injection pois os argumentos são passados como array
      const certbot = spawn('certbot', [
        'certonly',
        '--webroot',
        '-w', this.webrootPath,
        '-d', domain,
        '--email', email,
        '--agree-tos',
        '--no-eff-email',
        '--force-renewal',
        '--non-interactive'
      ]);

      let stdout = '';
      let stderr = '';

      certbot.stdout.on('data', (data) => { stdout += data.toString(); });
      certbot.stderr.on('data', (data) => { stderr += data.toString(); });

      certbot.on('close', (code) => {
        if (code === 0) {
          console.log(`[CertManager] Sucesso: ${stdout}`);
          resolve({ success: true, message: 'Certificado gerado com sucesso! O Nginx deve recarregar automaticamente em breve.' });
        } else {
          console.error(`[CertManager] Falha (Code ${code}): ${stderr}`);
          // Mensagem amigável baseada no erro
          let errorMsg = 'Falha desconhecida no Certbot.';
          if (stderr.includes('Unauthorized')) errorMsg = 'Erro de validação: O domínio não aponta para este servidor.';
          if (stderr.includes('Connection refused')) errorMsg = 'Erro de rede: O Certbot não conseguiu conectar.';
          
          reject(new Error(`${errorMsg} Logs: ${stderr.slice(-200)}`));
        }
      });
    });
  }

  public static async requestCertificate(domain: string, email: string, provider: CertProvider, manualData?: { cert: string, key: string }): Promise<{ success: boolean, message: string }> {
    
    if (provider === 'manual' || provider === 'cloudflare_pem' as any) {
        if (!manualData?.cert || !manualData?.key) {
            throw new Error("Certificado e Chave são obrigatórios para modo manual.");
        }
        return this.provisionManual(domain, manualData.cert, manualData.key);
    }

    if (provider === 'certbot' || provider === 'letsencrypt' as any) {
        return this.provisionCertbot(domain, email);
    }

    throw new Error("Provedor SSL desconhecido.");
  }
}