import React, { useState, useEffect } from 'react';
import { 
  Shield, Key, Globe, Lock, Save, Loader2, CheckCircle2, Copy, 
  Terminal, Eye, EyeOff, RefreshCw, Code, BookOpen, AlertTriangle,
  Server, ExternalLink, Plus, X, Link
} from 'lucide-react';

const ProjectSettings: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [project, setProject] = useState<any>(null);
  const [customDomain, setCustomDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  
  // Origins State
  const [origins, setOrigins] = useState<any[]>([]);
  const [newOrigin, setNewOrigin] = useState('');

  const fetchProject = async () => {
    const res = await fetch('/api/control/projects', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
    });
    const data = await res.json();
    const current = data.find((p: any) => p.slug === projectId);
    setProject(current);
    setCustomDomain(current?.custom_domain || '');
    
    const rawOrigins = current?.metadata?.allowed_origins || [];
    setOrigins(rawOrigins.map((o: any) => typeof o === 'string' ? { url: o, require_auth: true } : o));
    
    setLoading(false);
  };

  useEffect(() => { fetchProject(); }, [projectId]);

  const isValidUrl = (str: string) => {
    try {
      new URL(str);
      return true;
    } catch {
      return false;
    }
  };

  const handleUpdateSettings = async (overrideOrigins?: any[]) => {
    setSaving(true);
    try {
      const payload: any = { custom_domain: customDomain };
      if (overrideOrigins) payload.metadata = { allowed_origins: overrideOrigins };

      const res = await fetch(`/api/control/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setSuccess('Configuração atualizada.');
        if (!overrideOrigins) fetchProject(); // Only refetch if simple save
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch (e) {
      alert('Erro ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  const addOrigin = () => {
    if (!newOrigin) return;
    if (!isValidUrl(newOrigin)) {
        alert('URL inválida. Use o formato completo: https://seu-site.com');
        return;
    }
    const updated = [...origins, { url: newOrigin, require_auth: true }];
    setOrigins(updated);
    setNewOrigin('');
    handleUpdateSettings(updated);
  };

  const removeOrigin = (url: string) => {
    const updated = origins.filter(o => o.url !== url);
    setOrigins(updated);
    handleUpdateSettings(updated);
  };

  const rotateKey = async (type: string) => {
    if (!confirm('Isso invalidará a chave atual imediatamente. Continuar?')) return;
    setRotating(type);
    try {
      await fetch(`/api/control/projects/${projectId}/rotate-keys`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify({ type })
      });
      await fetchProject();
      setSuccess(`${type.toUpperCase()} rotacionada.`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      alert('Falha ao rotacionar chave.');
    } finally {
      setRotating(null);
    }
  };

  if (loading) return <div className="p-20 flex justify-center"><Loader2 className="animate-spin text-indigo-600" /></div>;

  const apiEndpoint = project?.custom_domain 
    ? `https://${project.custom_domain}` 
    : `${window.location.origin}/api/data/${project?.slug}`;

  const sdkCode = `
import { createClient } from './lib/cascata-sdk';

const cascata = createClient(
  '${apiEndpoint}',
  '${project?.anon_key}'
);

// Exemplo de uso
const { data } = await cascata.from('users').select();
  `.trim();

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-12 pb-40">
      {success && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[500] p-5 rounded-3xl bg-indigo-600 text-white shadow-2xl flex items-center gap-4 animate-bounce">
          <CheckCircle2 size={20} />
          <span className="text-sm font-black uppercase tracking-tight">{success}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        {/* Infraestrutura e Domínio */}
        <div className="bg-white border border-slate-200 rounded-[3.5rem] p-12 shadow-sm space-y-10">
           <div className="flex items-center justify-between">
              <h3 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-4">
                <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><Globe size={20} /></div>
                Exposição de API
              </h3>
              <button onClick={() => handleUpdateSettings()} disabled={saving} className="bg-slate-900 text-white px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2">
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Salvar Domínio
              </button>
           </div>
           
           <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Custom API Domain (FQDN)</label>
                <input 
                  value={customDomain} 
                  onChange={(e) => setCustomDomain(e.target.value)} 
                  placeholder="api.meu-app.com"
                  className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 px-6 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" 
                />
                <p className="text-[10px] text-slate-400 font-medium px-2">Aponte o CNAME/A do seu domínio para <b>{window.location.hostname}</b> para ativar o isolamento.</p>
              </div>

              <div className="p-6 bg-slate-50 rounded-2xl border border-slate-100 space-y-4">
                <div>
                   <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block mb-1">Default Instance Endpoint</span>
                   <code className="text-xs font-mono font-bold text-indigo-600 break-all">{window.location.origin}/api/data/{project?.slug}</code>
                </div>
              </div>
           </div>
        </div>

        {/* Global Origins Registry */}
        <div className="bg-white border border-slate-200 rounded-[3.5rem] p-12 shadow-sm space-y-10">
           <h3 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-4">
              <div className="w-12 h-12 bg-emerald-600 text-white rounded-2xl flex items-center justify-center shadow-lg"><Link size={20} /></div>
              Global Allowed Origins (URL Locking)
           </h3>
           
           <div className="space-y-6">
              <p className="text-slate-500 text-xs font-medium">
                Lista mestre de URLs confiáveis. URLs adicionadas aqui aparecerão como sugestões ao configurar Strategies individuais.
              </p>
              
              <div className="flex gap-4">
                 <input 
                   value={newOrigin} 
                   onChange={(e) => setNewOrigin(e.target.value)} 
                   placeholder="https://meu-app.com"
                   className="flex-1 bg-slate-50 border border-slate-100 rounded-2xl py-3 px-6 text-sm font-bold outline-none focus:ring-4 focus:ring-emerald-500/10" 
                 />
                 <button onClick={addOrigin} className="bg-emerald-600 text-white px-4 rounded-2xl hover:bg-emerald-700 transition-all"><Plus size={20} /></button>
              </div>

              <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                 {origins.map((origin, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-slate-50 p-4 rounded-2xl border border-slate-100">
                       <span className="text-xs font-bold text-slate-700">{origin.url}</span>
                       <button onClick={() => removeOrigin(origin.url)} className="text-slate-300 hover:text-rose-600"><X size={16} /></button>
                    </div>
                 ))}
                 {origins.length === 0 && <span className="text-xs text-slate-300 font-bold block text-center py-4">Nenhuma origem global definida.</span>}
              </div>
           </div>
        </div>

        {/* Segurança e Chaves */}
        <div className="bg-white border border-slate-200 rounded-[3.5rem] p-12 shadow-sm space-y-10">
           <h3 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-4">
              <div className="w-12 h-12 bg-slate-900 text-white rounded-2xl flex items-center justify-center shadow-lg"><Lock size={20} /></div>
              Gerenciamento de Segredos
           </h3>
           <div className="space-y-8">
              <KeyControl 
                label="Anon Key" 
                value={project?.anon_key} 
                onRotate={() => rotateKey('anon')} 
                loading={rotating === 'anon'}
              />
              <KeyControl 
                label="Service Key" 
                value={project?.service_key} 
                secret 
                onRotate={() => rotateKey('service')} 
                loading={rotating === 'service'}
              />
              <KeyControl 
                label="JWT Secret" 
                value={project?.jwt_secret} 
                secret 
                onRotate={() => rotateKey('jwt')} 
                loading={rotating === 'jwt'}
              />
           </div>
        </div>

        {/* Integração SDK Nativo */}
        <div className="bg-slate-900 border border-slate-800 rounded-[3.5rem] p-12 shadow-sm space-y-8">
           <div className="flex items-center justify-between">
              <h3 className="text-2xl font-black text-white tracking-tight flex items-center gap-4">
                <div className="w-12 h-12 bg-indigo-600 text-white rounded-2xl flex items-center justify-center"><Code size={20} /></div>
                Cascata SDK (Nativo)
              </h3>
              <span className="text-[10px] font-black text-indigo-400 border border-indigo-400/30 px-3 py-1 rounded-full uppercase">Independente</span>
           </div>
           
           <div className="space-y-4">
              <p className="text-slate-400 text-sm font-medium leading-relaxed">
                Use nosso SDK minimalista para integração direta. Sem dependências pesadas, focado em performance pura.
              </p>
              <div className="relative group">
                <pre className="bg-slate-950 p-8 rounded-[2rem] text-[11px] font-mono text-emerald-400 overflow-x-auto leading-relaxed border border-white/5">
                  {sdkCode}
                </pre>
                <button 
                  onClick={() => navigator.clipboard.writeText(sdkCode)}
                  className="absolute top-4 right-4 p-3 bg-white/5 hover:bg-white/10 text-white rounded-xl transition-all"
                >
                  <Copy size={16} />
                </button>
              </div>
           </div>

           <div className="p-6 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex gap-4">
              <AlertTriangle className="text-amber-500 shrink-0" size={20} />
              <p className="text-[11px] text-amber-200 font-medium">
                Mantenha a <b>Service Key</b> apenas em ambientes de servidor (Node, Python, etc). Nunca a exponha no código do navegador.
              </p>
           </div>
        </div>
      </div>
    </div>
  );
};

const KeyControl = ({ label, value, secret = false, onRotate, loading }: any) => {
  const [show, setShow] = useState(!secret);
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center px-1">
        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{label}</label>
        <div className="flex gap-4">
          {secret && (
            <button onClick={() => setShow(!show)} className="text-[10px] font-black text-indigo-600 uppercase hover:underline">
              {show ? 'Esconder' : 'Mostrar'}
            </button>
          )}
          <button onClick={onRotate} disabled={loading} className="text-[10px] font-black text-rose-600 uppercase hover:underline flex items-center gap-1">
            {loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />} Rotacionar
          </button>
        </div>
      </div>
      <div className="relative group">
        <input 
          type={show ? 'text' : 'password'}
          value={value}
          readOnly
          className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-6 pr-14 text-[12px] font-mono font-bold text-slate-700 outline-none" 
        />
        <button onClick={() => navigator.clipboard.writeText(value)} className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-300 hover:text-indigo-600 p-2">
          <Copy size={16} />
        </button>
      </div>
    </div>
  );
};

export default ProjectSettings;