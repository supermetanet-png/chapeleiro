
import React, { useState, useEffect } from 'react';
import { 
  AppWindow, Plus, Play, Square, Trash2, ExternalLink, 
  Terminal, Globe, Loader2, CheckCircle2, AlertCircle, 
  Settings, X, CloudLightning, Download, ShoppingBag, Server
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
  const [installModal, setInstallModal] = useState<any>(null); // App being installed
  const [installConfig, setInstallConfig] = useState({ domain: '' });
  const [installing, setInstalling] = useState(false);

  // FETCHERS
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
    try {
      const res = await fetch(`/api/control/store/apps`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      setStoreApps(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoadingStore(false); }
  };

  useEffect(() => { 
      if (activeTab === 'installed') fetchInstalledApps();
      if (activeTab === 'store') fetchStore();
  }, [projectId, activeTab]);

  // ACTIONS
  const handleInstall = async () => {
    if (!installConfig.domain) return;
    setInstalling(true);
    try {
      await fetch(`/api/control/projects/${projectId}/apps/install`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify({ 
            appId: installModal.id, 
            domain: installConfig.domain 
        })
      });
      setInstallModal(null);
      setInstallConfig({ domain: '' });
      setActiveTab('installed');
    } catch (e) {
      alert("Falha no deploy. Verifique se o domínio é válido e aponte para este servidor.");
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
    if(!confirm("Excluir este app permanentemente? Os dados no banco serão mantidos por segurança, mas o container será removido.")) return;
    await fetch(`/api/control/projects/${projectId}/apps/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
    });
    fetchInstalledApps();
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
                            onClick={() => setInstallModal(item)}
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
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Subdomínio da Aplicação</label>
                    <input 
                      autoFocus
                      value={installConfig.domain}
                      onChange={(e) => setInstallConfig({...installConfig, domain: e.target.value})}
                      placeholder={`app.${window.location.hostname}`}
                      className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-4 px-6 text-lg font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10"
                    />
                    <p className="text-[10px] text-slate-400 font-bold px-2">O banco de dados será criado isoladamente como <code>app_{projectId}_{installModal.id}_...</code></p>
                 </div>
                 
                 <button onClick={handleInstall} disabled={installing || !installConfig.domain} className="w-full bg-indigo-600 text-white py-5 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl flex items-center justify-center gap-3 hover:bg-indigo-700 transition-all disabled:opacity-50">
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
