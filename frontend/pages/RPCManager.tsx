
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Code2, 
  Play, 
  Plus, 
  Book, 
  Clock, 
  Terminal, 
  Loader2, 
  Folder, 
  FolderPlus, 
  ChevronRight, 
  ChevronDown, 
  FileCode, 
  Search, 
  MoreVertical, 
  Trash2, 
  Copy, 
  CheckCircle2, 
  X, 
  Zap, 
  Info,
  ExternalLink,
  Save,
  Cpu,
  RefreshCw,
  Layout,
  AlertCircle,
  Edit,
  Edit2,
  BookOpen
} from 'lucide-react';

type AssetType = 'rpc' | 'trigger' | 'cron' | 'folder';

interface ProjectAsset {
  id: string;
  name: string;
  type: AssetType;
  parent_id: string | null;
  metadata: {
    notes?: string;
    sql?: string;
    db_object_name?: string;
  };
}

interface AssetTreeNode extends ProjectAsset {
  children: AssetTreeNode[];
}

const RPCManager: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [activeContext, setActiveContext] = useState<AssetType>('rpc');
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [dbObjects, setDbObjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<ProjectAsset | null>(null);
  const [projectData, setProjectData] = useState<any>(null);
  
  // Editor State
  const [editorSql, setEditorSql] = useState('-- Writing high-performance SQL...');
  const [notes, setNotes] = useState('');
  const [testParams, setTestParams] = useState('{}');
  const [testResult, setTestResult] = useState<any>(null);
  
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Context Menu & Renaming State
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, item: AssetTreeNode } | null>(null);
  const [renamingItem, setRenamingItem] = useState<ProjectAsset | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const fetchWithAuth = useCallback(async (url: string, options: any = {}) => {
    const token = localStorage.getItem('cascata_token');
    const response = await fetch(url, {
      ...options,
      headers: { ...options.headers, 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Error ${response.status}`);
    }
    return response.json();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [assetsData, functionsData, triggersData, projects] = await Promise.all([
        fetchWithAuth(`/api/data/${projectId}/assets`),
        fetchWithAuth(`/api/data/${projectId}/functions`),
        fetchWithAuth(`/api/data/${projectId}/triggers`),
        fetchWithAuth(`/api/control/projects`)
      ]);
      setAssets(assetsData);
      setDbObjects([...functionsData.map((f:any) => ({...f, type: 'rpc'})), ...triggersData.map((t:any) => ({...t, type: 'trigger'}))]);
      setProjectData(projects.find((p: any) => p.slug === projectId));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const hide = () => setContextMenu(null);
    window.addEventListener('click', hide);
    return () => window.removeEventListener('click', hide);
  }, [projectId]);

  const safeCopyToClipboard = async (text: string) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
      setSuccessMsg('Copied to clipboard');
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (err) {
      setError('Failed to copy to clipboard');
    }
  };

  const extractObjectName = (sql: string): string | null => {
    const match = sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TRIGGER|VIEW|PROCEDURE)\s+(?:public\.)?(\w+)/i);
    return match ? match[1] : null;
  };

  const handleCreateAsset = async (name: string, type: AssetType, parentId: string | null = null) => {
    try {
      const newAsset = await fetchWithAuth(`/api/data/${projectId}/assets`, {
        method: 'POST',
        body: JSON.stringify({ name, type, parent_id: parentId })
      });
      setAssets([...assets, newAsset]);
      if (type !== 'folder') {
        setSelectedAsset(newAsset);
        setEditorSql('-- Write your SQL here...');
        setNotes('');
      }
      setSuccessMsg(`${type.toUpperCase()} initialized.`);
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSaveObject = async () => {
    if (!selectedAsset) return;
    setExecuting(true);
    try {
      await fetchWithAuth(`/api/data/${projectId}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql: editorSql })
      });
      const detectedName = extractObjectName(editorSql);
      const finalName = detectedName || selectedAsset.name;
      const updated = await fetchWithAuth(`/api/data/${projectId}/assets`, {
        method: 'POST',
        body: JSON.stringify({ 
          ...selectedAsset,
          name: finalName,
          metadata: { ...selectedAsset.metadata, notes, sql: editorSql } 
        })
      });
      setAssets(assets.map(a => a.id === updated.id ? updated : a));
      setSelectedAsset(updated);
      setSuccessMsg(`Compiled successfully as "${finalName}"`);
      setTimeout(() => setSuccessMsg(null), 2000);
      fetchData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  };

  const handleDeleteAsset = async (id: string) => {
    try {
      await fetchWithAuth(`/api/data/${projectId}/assets/${id}`, { method: 'DELETE' });
      setAssets(assets.filter(a => a.id !== id));
      if (selectedAsset?.id === id) setSelectedAsset(null);
      setSuccessMsg('Asset purged.');
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRename = async () => {
    if (!renamingItem || !renameValue) return;
    try {
      const updated = await fetchWithAuth(`/api/data/${projectId}/assets`, {
        method: 'POST',
        body: JSON.stringify({ ...renamingItem, name: renameValue })
      });
      setAssets(assets.map(a => a.id === updated.id ? updated : a));
      if (selectedAsset?.id === updated.id) setSelectedAsset(updated);
      setRenamingItem(null);
      setSuccessMsg('Renamed successfully.');
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const executeTest = async () => {
    if (!selectedAsset) return;
    setExecuting(true);
    try {
      let params = {};
      try { params = JSON.parse(testParams); } catch(e) { }
      const paramValues = Object.values(params);
      const argsString = paramValues.length > 0 
        ? paramValues.map(v => typeof v === 'string' ? `'${v}'` : v).join(', ') 
        : '';
      const sql = selectedAsset.type === 'rpc' 
        ? `SELECT * FROM public."${selectedAsset.name}"(${argsString})`
        : `-- Execution check for ${selectedAsset.type}`;
      const result = await fetchWithAuth(`/api/data/${projectId}/query`, {
        method: 'POST',
        body: JSON.stringify({ sql })
      });
      setTestResult(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  };

  const copyCurl = () => {
    if (!selectedAsset || !projectData) return;
    
    // Detecta o protocolo atual para gerar o cURL correto (evita forçar HTTPS se não estiver disponível)
    const protocol = window.location.protocol;
    const endpoint = projectData.custom_domain 
      ? `${protocol}//${projectData.custom_domain}/rpc/${selectedAsset.name}`
      : `${window.location.origin}/api/data/${projectId}/rpc/${selectedAsset.name}`;

    const curl = `curl -X POST ${endpoint} \\
  -H "Content-Type: application/json" \\
  -H "apikey: ${projectData.anon_key}" \\
  -d '${testParams}'`;
    safeCopyToClipboard(curl);
  };

  const filteredAssets = useMemo(() => {
    return assets.filter(a => a.type === 'folder' || a.type === activeContext);
  }, [assets, activeContext]);

  const treeData = useMemo(() => {
    const buildTree = (parentId: string | null = null): AssetTreeNode[] => {
      return filteredAssets
        .filter(a => a.parent_id === parentId)
        .map(a => ({
          ...a,
          children: a.type === 'folder' ? buildTree(a.id) : []
        }));
    };
    return buildTree(null);
  }, [filteredAssets]);

  const toggleFolder = (id: string) => {
    const next = new Set(expandedFolders);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedFolders(next);
  };

  const renderTreeItem = (item: AssetTreeNode) => {
    const isFolder = item.type === 'folder';
    const isExpanded = expandedFolders.has(item.id);
    const isSelected = selectedAsset?.id === item.id;

    return (
      <div key={item.id} className="select-none">
        <div 
          onClick={() => {
            if (isFolder) toggleFolder(item.id);
            else {
              setSelectedAsset(item);
              setEditorSql(item.metadata?.sql || `-- Define ${item.name}...`);
              setNotes(item.metadata?.notes || '');
              setTestResult(null);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ x: e.clientX, y: e.clientY, item });
          }}
          className={`flex items-center gap-2 px-3 py-2.5 rounded-xl cursor-pointer transition-all group ${isSelected ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-100' : 'text-slate-600 hover:bg-slate-50'}`}
        >
          {isFolder ? (
            <>
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Folder size={18} className={isSelected ? 'text-white' : 'text-slate-400'} />
            </>
          ) : (
            <FileCode size={18} className={isSelected ? 'text-white' : 'text-slate-400'} />
          )}
          <span className="text-sm font-bold truncate">{item.name}</span>
          <div className={`ml-auto opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? 'text-white' : 'text-slate-300'}`}>
            <MoreVertical size={14} />
          </div>
        </div>
        {isFolder && isExpanded && (
          <div className="pl-6 mt-1 space-y-1">
            {item.children.map(renderTreeItem)}
            {item.children.length === 0 && (
              <div className="px-3 py-1.5 text-[9px] font-bold text-slate-300 uppercase tracking-widest italic">Empty Folder</div>
            )}
            <button 
              onClick={(e) => { e.stopPropagation(); handleCreateAsset('new_' + activeContext, activeContext, item.id); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-black text-slate-400 uppercase tracking-widest hover:text-indigo-600 transition-colors"
            >
              <Plus size={12} /> Add {activeContext.toUpperCase()}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-[#FDFDFD] overflow-hidden relative">
      {contextMenu && (
        <div 
          className="fixed z-[500] bg-white border border-slate-200 shadow-2xl rounded-2xl p-2 w-56 animate-in fade-in zoom-in-95" 
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => { setRenamingItem(contextMenu.item); setRenameValue(contextMenu.item.name); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><Edit size={14}/> Rename</button>
          {contextMenu.item.type === 'folder' && (
            <button onClick={() => { handleCreateAsset('sub_folder', 'folder', contextMenu.item.id); setContextMenu(null); }} className="w-full flex items-center gap-3 px-4 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50 rounded-xl transition-all"><FolderPlus size={14}/> Create Subfolder</button>
          )}
          <div className="h-[1px] bg-slate-100 my-1"></div>
          <button 
            disabled={contextMenu.item.type === 'folder' && contextMenu.item.children.length > 0}
            onClick={() => { handleDeleteAsset(contextMenu.item.id); setContextMenu(null); }} 
            className={`w-full flex items-center justify-between px-4 py-3 text-xs font-black transition-all rounded-xl ${contextMenu.item.type === 'folder' && contextMenu.item.children.length > 0 ? 'text-slate-300 cursor-not-allowed' : 'text-rose-600 hover:bg-rose-50'}`}
          >
            <div className="flex items-center gap-3"><Trash2 size={14}/> Delete</div>
            {contextMenu.item.type === 'folder' && contextMenu.item.children.length > 0 && <span title="Folder must be empty" className="text-slate-400"><Info size={12} /></span>}
          </button>
        </div>
      )}

      {renamingItem && (
        <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-sm z-[600] flex items-center justify-center p-6">
          <div className="bg-white rounded-3xl p-8 w-full max-w-sm shadow-2xl border border-slate-100">
            <h4 className="text-lg font-black text-slate-900 tracking-tight mb-4">Rename Asset</h4>
            <input 
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-2xl py-3 px-5 text-sm font-bold text-slate-800 outline-none focus:ring-4 focus:ring-indigo-500/10 mb-6"
              onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            />
            <div className="flex gap-4">
              <button onClick={() => setRenamingItem(null)} className="flex-1 py-3 text-xs font-black text-slate-400 uppercase tracking-widest">Cancel</button>
              <button onClick={handleRename} className="flex-[2] py-3 bg-indigo-600 text-white rounded-2xl text-xs font-black uppercase tracking-widest shadow-lg shadow-indigo-100">Confirm Rename</button>
            </div>
          </div>
        </div>
      )}

      {(error || successMsg) && (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[400] p-5 rounded-3xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
          {error ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
          <span className="text-sm font-black tracking-tight">{error || successMsg}</span>
          <button onClick={() => { setError(null); setSuccessMsg(null); }} className="ml-4 opacity-50 hover:opacity-100"><X size={16} /></button>
        </div>
      )}

      <header className="border-b border-slate-200 px-10 py-6 bg-white flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-slate-900 text-white rounded-2xl shadow-xl"><Cpu size={24} /></div>
          <div><h2 className="text-2xl font-black text-slate-900 tracking-tighter leading-tight">Logic Engine</h2><p className="text-[10px] text-indigo-600 font-bold uppercase tracking-[0.2em]">Asset Orchestration</p></div>
        </div>
        <div className="flex items-center gap-8">
          <div className="flex items-center bg-slate-100 p-1.5 rounded-2xl">
            <button onClick={() => { setActiveContext('rpc'); setSelectedAsset(null); }} className={`px-8 py-2.5 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeContext === 'rpc' ? 'bg-white shadow-lg text-indigo-600' : 'text-slate-500'}`}><Code2 size={16}/> RPC</button>
            <button onClick={() => { setActiveContext('trigger'); setSelectedAsset(null); }} className={`px-8 py-2.5 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeContext === 'trigger' ? 'bg-white shadow-lg text-indigo-600' : 'text-slate-500'}`}><Zap size={16}/> TRIGGERS</button>
            <button onClick={() => { setActiveContext('cron'); setSelectedAsset(null); }} className={`px-8 py-2.5 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeContext === 'cron' ? 'bg-white shadow-lg text-indigo-600' : 'text-slate-500'}`}><Clock size={16}/> CRON JOBS</button>
          </div>
          <button onClick={() => handleCreateAsset('new_folder', 'folder')} className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-2xl transition-all" title="New Folder"><FolderPlus size={24} /></button>
          <button onClick={() => handleCreateAsset('new_' + activeContext, activeContext)} className="bg-indigo-600 text-white px-8 py-3.5 rounded-2xl text-xs font-black flex items-center gap-3 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100"><Plus size={20} /> NEW {activeContext.toUpperCase()}</button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-80 border-r border-slate-200 bg-white flex flex-col shrink-0">
          <div className="p-6">
            <div className="relative group"><Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-indigo-500 transition-colors" size={16} /><input placeholder="Search logic registry..." className="w-full pl-12 pr-4 py-3.5 text-sm bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" /></div>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-10 space-y-1">
            <div className="flex items-center justify-between px-3 py-4"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{activeContext} Registry</span><RefreshCw size={12} className={`text-slate-300 hover:text-indigo-600 cursor-pointer ${loading ? 'animate-spin' : ''}`} onClick={fetchData} /></div>
            {treeData.map(renderTreeItem)}
          </div>
        </aside>

        <main className="flex-1 overflow-hidden flex flex-col bg-[#F8FAFC]">
          {selectedAsset ? (
            <div className="flex-1 flex flex-col">
              <div className="bg-white border-b border-slate-200 px-10 py-5 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-6">
                  <div className="flex flex-col"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Asset Identifier</span><span className="text-xl font-black text-slate-900 tracking-tight font-mono">{selectedAsset.name}</span></div>
                  <div className="h-10 w-[1px] bg-slate-200"></div>
                  <div className="flex items-center gap-2"><span className={`w-2.5 h-2.5 rounded-full ${dbObjects.some(o => o.name === selectedAsset.name) ? 'bg-emerald-500' : 'bg-slate-200 animate-pulse'}`}></span><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{dbObjects.some(o => o.name === selectedAsset.name) ? 'Synchronized' : 'Draft Mode'}</span></div>
                </div>
                <div className="flex items-center gap-4">
                  <button onClick={handleSaveObject} disabled={executing} className="bg-indigo-600 text-white px-8 py-3 rounded-2xl text-xs font-black flex items-center gap-3 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 disabled:opacity-50">{executing ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} COMPILE & DEPLOY</button>
                </div>
              </div>

              <div className="flex-1 flex overflow-hidden">
                <div className="flex-1 flex flex-col border-r border-slate-200 relative">
                  <div className="flex-1 flex relative">
                    <textarea 
                      value={editorSql} 
                      onChange={(e) => setEditorSql(e.target.value)}
                      className="flex-1 bg-slate-950 text-emerald-400 p-12 font-mono text-base outline-none resize-none spellcheck-false" 
                    />
                    
                    <div className="w-[200px] bg-[#020617] border-l border-white/5 flex flex-col p-6 shrink-0 shadow-inner">
                       <span className="text-[10px] font-black text-slate-200 uppercase tracking-[0.2em] mb-4 flex items-center gap-2 border-b border-white/10 pb-4"><BookOpen size={14} className="text-indigo-400" /> Notes</span>
                       <textarea 
                        value={notes} 
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Describe the logic persona..." 
                        className="flex-1 bg-transparent text-slate-300 text-xs font-medium leading-relaxed outline-none resize-none placeholder:text-slate-800" 
                       />
                       <div className="mt-6 p-4 bg-indigo-500/5 rounded-2xl border border-indigo-500/10">
                         <p className="text-[9px] text-indigo-400 font-black leading-relaxed">Changes persist on deploy.</p>
                       </div>
                    </div>
                  </div>

                  <div className="h-96 border-t border-slate-200 bg-white p-10 flex gap-10 overflow-hidden shrink-0">
                    <div className="flex-1 flex flex-col gap-4">
                      <div className="flex items-center justify-between"><span className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><Layout size={14} className="text-indigo-600"/> Test Payload (JSON)</span></div>
                      <textarea 
                        value={testParams} 
                        onChange={(e) => setTestParams(e.target.value)}
                        className="flex-1 bg-slate-50 border border-slate-200 rounded-[2.5rem] p-8 font-mono text-sm outline-none focus:ring-4 focus:ring-indigo-500/5 transition-all shadow-inner" 
                        placeholder='{ "param": "value" }'
                      />
                    </div>
                    <div className="w-[480px] flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><Terminal size={14} className="text-emerald-500"/> Output Manifest</span>
                        <div className="flex items-center gap-2">
                          <button onClick={copyCurl} title="Copy cURL" className="p-3 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all"><Copy size={16}/></button>
                          <button onClick={executeTest} disabled={executing} className="bg-emerald-500 text-white px-8 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-3 hover:bg-emerald-600 transition-all shadow-xl shadow-emerald-500/20">{executing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run Logic</button>
                        </div>
                      </div>
                      <div className="flex-1 bg-slate-900 rounded-[2.5rem] p-8 font-mono text-xs text-slate-300 overflow-auto border border-white/5 shadow-2xl">
                        {testResult ? (
                          <pre className="whitespace-pre-wrap">{JSON.stringify(testResult, null, 2)}</pre>
                        ) : (
                          <div className="h-full flex flex-col items-center justify-center text-slate-700 gap-4 opacity-40">
                            <Terminal size={48}/>
                            <span className="text-[10px] uppercase font-black tracking-widest">Awaiting execution...</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-300 p-20 text-center relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-b from-indigo-500/5 to-transparent pointer-events-none"></div>
              <div className="w-36 h-36 bg-white rounded-[3.5rem] flex items-center justify-center text-indigo-600 mb-10 shadow-2xl border border-slate-100"><Code2 size={72} /></div>
              <h3 className="text-4xl font-black text-slate-900 tracking-tighter">Business Logic Workspace</h3>
              <p className="text-slate-400 mt-6 max-w-sm font-medium leading-relaxed">Select an asset from the logic registry or initialize a new interface to begin orchestration.</p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-16 w-full max-w-2xl relative z-10">
                 <div onClick={() => handleCreateAsset('new_rpc', 'rpc')} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 flex items-center gap-6 text-left hover:shadow-2xl hover:border-indigo-300 transition-all group cursor-pointer">
                    <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-[1.5rem] flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-all shadow-sm"><Code2 size={28}/></div>
                    <div><h4 className="font-black text-slate-900 text-sm uppercase tracking-tight leading-none">Create RPC</h4><p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-2">Map SQL to REST endpoints</p></div>
                 </div>
                 <div onClick={() => handleCreateAsset('new_trigger', 'trigger')} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 flex items-center gap-6 text-left hover:shadow-2xl hover:border-emerald-300 transition-all group cursor-pointer">
                    <div className="w-16 h-16 bg-emerald-50 text-emerald-600 rounded-[1.5rem] flex items-center justify-center group-hover:bg-emerald-600 group-hover:text-white transition-all shadow-sm"><Zap size={28}/></div>
                    <div><h4 className="font-black text-slate-900 text-sm uppercase tracking-tight leading-none">Event Trigger</h4><p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-2">Automate row-level actions</p></div>
                 </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default RPCManager;