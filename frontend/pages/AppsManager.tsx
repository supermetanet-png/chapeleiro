
import React, { useState, useEffect } from 'react';
import { 
  AppWindow, Plus, Play, Square, Trash2, ExternalLink, 
  Terminal, Globe, Loader2, CheckCircle2, AlertCircle, 
  Settings, X, CloudLightning, Download, ShoppingBag, Server, AlertTriangle
} from 'lucide-react';

const AppsManager: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [activeTab, setActiveTab] = useState<'installed' | 'store'>('installed');
  
  // INSTALLED APPS STATE
  const [apps, setApps] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedApp, setSelectedApp] = useState<any>(null);
  const [logs, setLogs] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);

  // STORE STATE
  const [storeApps, setStoreApps] = useState<any[]>([]);
  const [loadingStore, setLoadingStore] = useState(false);
  const [storeError, setStoreError] = useState('');
  
  // INSTALLATION STATE
  const [installModal, setInstallModal] = useState<any>(null);
  const [subdomain, setSubdomain] = useState('');
  const [systemDomain, setSystemDomain] = useState('');
  const [installing, setInstalling] = useState(false);

  // FETCHERS
  const fetchSystemConfig = async () => {
      try {
          const res = await fetch('/api/control/system/settings', {
              headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
          });
          const data = await res.json();
          if (data.domain) setSystemDomain(data.domain);
      } catch (e) { console.error("Falha ao carregar config do sistema"); }
  };

  const fetchInstalledApps = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/control/projects/${projectId}/apps`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      setApps(await res.json());
    } catch (e) { console.error(e); } 
    finally { setLoading(false); }
  };

  const fetchStore = async () => {
    setLoadingStore(true);
    setStoreError('');
    try {
      const res = await fetch(`/api/control/store/apps`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setStoreApps(await res.json());
    } catch (e: any) { 
        setStoreError(e.message);
    }
    finally { setLoadingStore(false); }
  };

  useEffect(() => { 
      fetchSystemConfig();
      if (activeTab === 'installed') fetchInstalledApps();
      if (activeTab === 'store') fetchStore();
  }, [projectId, activeTab]);

  // ACTIONS
  const handleInstall = async () => {
    // Constrói o domínio final
    const finalDomain = systemDomain ? `${subdomain}.${systemDomain}` : subdomain;
    
    if (!finalDomain) {
        alert("Domínio inválido.");
        return;
    }

    setInstalling(true);
    try {
      const res = await fetch(`/api/control/projects/${projectId}/apps/install`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify({ 
            appId: installModal.id, 
            domain: finalDomain
        })
      });
      
      if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Erro na instalação");
      }

      setInstallModal(null);
      setSubdomain('');
      setActiveTab('installed');
      fetchInstalledApps(); // Refresh imediato
    } catch (e: any) {
      alert(`Falha no deploy: ${e.message}`);
    } finally {
      setInstalling(false);
    }
  };

  const handleAction = async (id: string, action: 'stop' | 'start') => {
    await fetch(`/api/control/projects/${projectId}/apps/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` },
        body: JSON.stringify({ action })
    });
    fetchInstalledApps();
  };

  const handleDelete = async (id: string) => {
    if(!confirm("Excluir este app permanentemente? Os dados no banco serão apagados.")) return;
    try {
        const res = await fetch(`/api/control/projects/${projectId}/apps/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        if (!res.ok) throw new Error("Erro ao excluir");
        fetchInstalledApps();
    } catch(e) {
        alert("Erro ao excluir aplicação. Verifique os logs.");
    }
  };

  const fetchLogs = async (appId: string) => {
    setLoadingLogs(true);
    try {
        const res = await fetch(`/api/control/projects/${projectId}/apps/${appId}/logs`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        const data = await res.json();
        setLogs(data.logs);
    } catch(e) {}
    finally { setLoadingLogs(false); }
  };

  return (
    <div className="p-8 lg:p-12 max-w-7xl mx-auto w-full space-y-12 pb-40">
      <header className="flex items-end justify-between gap-8">
        <div>
          <h2 className="text-4xl font-black text-slate-900 tracking-tighter">App Orchestrator</h2>
          <p className="text-slate-500 mt-2 text-lg">Gerenciamento de infraestrutura dedicada e aplicativos integrados.</p>
        </div>
        <div className="flex bg-slate-100 p-1 rounded-2xl">
            <button onClick={() => setActiveTab('installed')} className={`px-6 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${activeTab === 'installed' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-500'}`}>
                <Server size={16}/> Installed
            </button>
            <button onClick={() => setActiveTab('store')} className={`px-6 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${activeTab === 'store' ? 'bg-white shadow-md text-indigo-600' : 'text-slate-500'}`}>
                <ShoppingBag size={16}/> App Store
            </button>
        </div>
      </header>

      {/* INSTALLED VIEW */}
      {activeTab === 'installed' && (
          loading ? (
            <div className="py-40 flex flex-col items-center justify-center text-slate-300">
              <Loader2 size={60} className="animate-spin mb-6" />
              <p className="text-sm font-black uppercase tracking-widest">Carregando containers...</p>
            </div>
          ) : apps.length === 0 ? (
            <div className="py-40 border-4 border-dashed border-slate-100 rounded-[3rem] flex flex-col items-center justify-center text-slate-300">
              <AppWindow size={60} className="mb-4 opacity-10" />
              <p className="text-[10px] font-black uppercase tracking-widest">Nenhuma aplicação rodando.</p>
              <button onClick={() => setActiveTab('store')} className="mt-4 text-indigo-600 hover:underline font-bold text-xs">Ir para a Loja</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {apps.map(app => (
                <div key={app.id} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 hover:shadow-2xl transition-all group relative overflow-hidden">
                   <div className="flex justify-between items-start mb-8 relative z-10">
                      <div className="flex items-center gap-4">
                         <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center font-black text-2xl shadow-sm">{app.type.substring(0,2).toUpperCase()}</div>
                         <div>
                            <h3 className="text-xl font-black text-slate-900 capitalize">{app.type}</h3>
                            <a href={`https://${app.domain}`} target="_blank" className="text-xs font-bold text-indigo-600 hover:underline flex items-center gap-1 mt-1">
                               <Globe size={12}/> {app.domain}
                            </a>
                         </div>
                      </div>
                      <div className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${app.status === 'running' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                         {app.status}
                      </div>
                   </div>
    
                   <div className="flex gap-4 relative z-10">
                      {app.status === 'running' ? (
                         <button onClick={() => handleAction(app.id, 'stop')} className="p-3 bg-slate-100 hover:bg-slate-200 rounded-xl text-slate-600 transition-all"><Square size={18}/></button>
                      ) : (
                         <button onClick={() => handleAction(app.id, 'start')} className="p-3 bg-emerald-100 hover:bg-emerald-200 rounded-xl text-emerald-700 transition-all"><Play size={18}/></button>
                      )}
                      <button onClick={() => { setSelectedApp(app); fetchLogs(app.id); }} className="flex-1 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-600 transition-all">Console & Env</button>
                      <button onClick={() => handleDelete(app.id)} className="p-3 bg-rose-50 hover:bg-rose-100 rounded-xl text-rose-600 transition-all"><Trash2 size={18}/></button>
                   </div>
                </div>
              ))}
            </div>
          )
      )}

      {/* STORE VIEW */}
      {activeTab === 'store' && (
          loadingStore ? (
            <div className="py-40 flex justify-center"><Loader2 className="animate-spin text-indigo-600" size={40}/></div>
          ) : storeError ? (
            <div className="py-20 flex flex-col items-center justify-center text-rose-400 gap-4">
                <AlertTriangle size={48}/>
                <p className="font-bold text-sm text-center max-w-md">{storeError}</p>
                <button onClick={fetchStore} className="px-6 py-2 bg-rose-50 text-rose-600 rounded-xl text-xs font-black uppercase hover:bg-rose-100">Tentar Novamente</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                {storeApps.map(item => (
                    <div key={item.id} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 hover:border-indigo-300 transition-all group hover:-translate-y-1 duration-300">
                        <div className="flex justify-between items-start mb-6">
                            <img src={item.logo} alt={item.name} className="w-16 h-16 rounded-2xl object-contain bg-slate-50 p-2" />
                            <span className="bg-indigo-50 text-indigo-700 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest">{item.version}</span>
                        </div>
                        <h3 className="text-lg font-black text-slate-900 mb-2">{item.name}</h3>
                        <p className="text-xs text-slate-500 font-medium mb-6 line-clamp-2 h-8">{item.description}</p>
                        
                        <div className="flex gap-2 mb-6">
                            {item.tags?.map((tag:string) => (
                                <span key={tag} className="text-[9px] font-bold bg-slate-100 text-slate-500 px-2 py-1 rounded-lg">{tag}</span>
                            ))}
                        </div>

                        <button 
                            onClick={() => { setInstallModal(item); setSubdomain(item.id); }}
                            className="w-full bg-slate-900 text-white py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-indigo-600 transition-all shadow-xl group-hover:shadow-indigo-200 flex items-center justify-center gap-2"
                        >
                            <Download size={14}/> Instalar
                        </button>
                    </div>
                ))}
            </div>
          )
      )}

      {/* INSTALL MODAL */}
      {installModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[500] flex items-center justify-center p-8 animate-in zoom-in-95">
           <div className="bg-white rounded-[3rem] w-full max-w-lg p-12 shadow-2xl border border-slate-200 relative">
              <h3 className="text-3xl font-black text-slate-900 tracking-tighter mb-2">Deploy {installModal.name}</h3>
              <p className="text-slate-500 text-sm font-medium mb-8">Configuração automática de Banco de Dados, Redis e Domínio.</p>
              
              <div className="space-y-6">
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">URL da Aplicação</label>
                    
                    {systemDomain ? (
                        // MODO FÁCIL: Subdomínio
                        <div className="flex items-center bg-slate-50 border border-slate-200 rounded-2xl overflow-hidden focus-within:ring-4 focus-within:ring-indigo-500/10">
                            <input 
                                autoFocus
                                value={subdomain}
                                onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                                placeholder="app-name"
                                className="flex-1 bg-transparent py-4 pl-6 text-lg font-bold text-slate-900 outline-none text-right"
                            />
                            <div className="bg-slate-100 py-4 pr-6 pl-2 text-slate-500 font-bold text-sm border-l border-slate-200">
                                .{systemDomain}
                            </div>
                        </div>
                    ) : (
                        // MODO MANUAL: Domínio completo (Fallback)
                        <input 
                            autoFocus
                            value={subdomain}
                            onChange={(e) => setSubdomain(e.target.value)}
                            placeholder="app.meudominio.com"
                            className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-lg font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10"
                        />
                    )}

                    {!systemDomain && (
                        <div className="flex gap-2 items-center text-amber-600 bg-amber-50 p-3 rounded-xl mt-2">
                            <AlertTriangle size={14}/>
                            <p className="text-[10px] font-bold">Nenhum domínio base configurado em 'System Settings'. Digite o domínio completo.</p>
                        </div>
                    )}
                 </div>
                 
                 <button onClick={handleInstall} disabled={installing || !subdomain} className="w-full bg-indigo-600 text-white py-5 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl flex items-center justify-center gap-3 hover:bg-indigo-700 transition-all disabled:opacity-50">
                    {installing ? <Loader2 className="animate-spin" size={18}/> : 'Iniciar Instalação'}
                 </button>
                 <button onClick={() => setInstallModal(null)} className="w-full py-4 text-xs font-bold text-slate-400 hover:text-slate-600">Cancelar</button>
              </div>
           </div>
        </div>
      )}

      {/* LOGS DRAWER */}
      {selectedApp && (
         <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[600] flex items-center justify-center p-8">
            <div className="bg-white rounded-[3rem] w-full max-w-4xl h-[80vh] flex flex-col shadow-2xl overflow-hidden">
               <header className="p-8 border-b border-slate-100 flex items-center justify-between">
                  <div>
                     <h3 className="text-2xl font-black text-slate-900">Console: {selectedApp.domain}</h3>
                     <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Container Output</p>
                  </div>
                  <button onClick={() => setSelectedApp(null)} className="p-3 bg-slate-100 rounded-full hover:bg-slate-200"><X size={20}/></button>
               </header>
               <div className="flex-1 bg-slate-950 p-8 overflow-auto font-mono text-xs text-emerald-400">
                  {loadingLogs ? <Loader2 className="animate-spin text-white"/> : <pre>{logs}</pre>}
               </div>
               <div className="p-8 bg-slate-50 border-t border-slate-100">
                  <h4 className="font-bold text-slate-900 mb-4 text-sm flex items-center gap-2"><Settings size={16}/> Environment Variables (Read-Only)</h4>
                  <div className="grid grid-cols-2 gap-4">
                     {Object.entries(selectedApp.env_vars || {}).map(([k, v]) => (
                        <div key={k} className="bg-white border border-slate-200 p-3 rounded-xl">
                           <span className="text-[9px] font-black text-slate-400 uppercase block">{k}</span>
                           <code className="text-[10px] text-slate-700 font-bold truncate block">{String(v).substring(0, 30)}...</code>
                        </div>
                     ))}
                  </div>
               </div>
            </div>
         </div>
      )}
    </div>
  );
};

export default AppsManager;
