
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Shield, Lock, Unlock, Plus, Trash2, Edit2, AlertCircle, Loader2, X, Terminal, CheckCircle2, Zap, User, Users, Globe, Eye, Code, ChevronDown, ChevronRight, Copy } from 'lucide-react';

const RLSManager: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [policies, setPolicies] = useState<any[]>([]);
  const [tables, setTables] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [isEditing, setIsEditing] = useState(false);
  const [selectedPolicyToDuplicate, setSelectedPolicyToDuplicate] = useState<any>(null);
  const [duplicateTargetTable, setDuplicateTargetTable] = useState('');

  // New/Edit Policy Form State
  const [newPolicy, setNewPolicy] = useState({
    name: '',
    table: '',
    command: 'SELECT',
    role: 'public',
    using: 'true',
    withCheck: '',
    oldName: '' // To handle renames during edit
  });

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
      const [policiesData, tablesData] = await Promise.all([
        fetchWithAuth(`/api/data/${projectId}/policies`),
        fetchWithAuth(`/api/data/${projectId}/tables`)
      ]);
      setPolicies(policiesData);
      setTables(tablesData);
      if (tablesData.length > 0 && !newPolicy.table) {
        setNewPolicy(prev => ({ ...prev, table: tablesData[0].name }));
      }
      
      // Auto-expand tables that have policies
      // Fix: Explicitly define Set type and ensure mapping returns strings to avoid Set<unknown> inference
      const tablesWithPolicies = new Set<string>((policiesData as any[]).map((p: any) => String(p.tablename)));
      setExpandedTables(tablesWithPolicies);

    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [projectId]);

  const safeRoles = (roles: any): string[] => {
    if (Array.isArray(roles)) return roles;
    if (typeof roles === 'string') {
      return roles.replace(/[{}]/g, '').split(',').map(r => r.trim());
    }
    return [];
  };

  const groupedPolicies = useMemo(() => {
    const groups: Record<string, any[]> = {};
    policies.forEach(p => {
      if (!groups[p.tablename]) groups[p.tablename] = [];
      groups[p.tablename].push(p);
    });
    return groups;
  }, [policies]);

  const toggleTable = (tableName: string) => {
    const next = new Set(expandedTables);
    if (next.has(tableName)) next.delete(tableName);
    else next.add(tableName);
    setExpandedTables(next);
  };

  const handleDelete = async (table: string, name: string) => {
    if (!confirm(`Are you sure you want to drop policy "${name}" on table "${table}"?`)) return;
    setExecuting(true);
    try {
      await fetchWithAuth(`/api/data/${projectId}/policies/${table}/${name}`, { method: 'DELETE' });
      setSuccessMsg('Policy dropped successfully.');
      fetchData();
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  };

  const handleEdit = (p: any) => {
    const roles = safeRoles(p.roles);
    setNewPolicy({
      name: p.policyname,
      oldName: p.policyname,
      table: p.tablename,
      command: p.cmd,
      role: roles[0] || 'public',
      using: p.qual || 'true',
      withCheck: p.with_check || ''
    });
    setIsEditing(true);
    setShowModal(true);
  };

  const openDuplicate = (p: any) => {
    setSelectedPolicyToDuplicate(p);
    setDuplicateTargetTable(tables[0]?.name || '');
    setShowDuplicateModal(true);
  };

  const handleDuplicate = async () => {
    if (!selectedPolicyToDuplicate || !duplicateTargetTable) return;
    setExecuting(true);
    try {
      const roles = safeRoles(selectedPolicyToDuplicate.roles);
      await fetchWithAuth(`/api/data/${projectId}/policies`, {
        method: 'POST',
        body: JSON.stringify({
          name: `${selectedPolicyToDuplicate.policyname} (Copy)`,
          table: duplicateTargetTable,
          command: selectedPolicyToDuplicate.cmd,
          role: roles[0] || 'public',
          using: selectedPolicyToDuplicate.qual || 'true',
          withCheck: selectedPolicyToDuplicate.with_check || ''
        })
      });
      setShowDuplicateModal(false);
      setSuccessMsg(`Policy duplicated to ${duplicateTargetTable}.`);
      fetchData();
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  };

  const handleCreateOrUpdate = async () => {
    if (!newPolicy.name || !newPolicy.table) {
      setError('Policy name and table are required.');
      return;
    }
    setExecuting(true);
    try {
      // If editing, we drop the old one first
      if (isEditing) {
        await fetchWithAuth(`/api/data/${projectId}/policies/${newPolicy.table}/${newPolicy.oldName}`, { method: 'DELETE' });
      }

      await fetchWithAuth(`/api/data/${projectId}/policies`, {
        method: 'POST',
        body: JSON.stringify(newPolicy)
      });

      setShowModal(false);
      setSuccessMsg(isEditing ? 'Policy updated successfully.' : 'Policy created and RLS enforced.');
      setIsEditing(false);
      fetchData();
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  };

  const applyTemplate = (type: string) => {
    switch (type) {
      case 'read_all':
        setNewPolicy({ ...newPolicy, name: `Enable read for all users`, command: 'SELECT', role: 'public', using: 'true', withCheck: '' });
        break;
      case 'auth_all':
        setNewPolicy({ ...newPolicy, name: `Allow authenticated full access`, command: 'ALL', role: 'authenticated', using: 'true', withCheck: 'true' });
        break;
      case 'user_own':
        setNewPolicy({ ...newPolicy, name: `Users can only see their own records`, command: 'SELECT', role: 'authenticated', using: 'user_id = auth.uid()', withCheck: '' });
        break;
      case 'user_manage':
        setNewPolicy({ ...newPolicy, name: `Users can manage their own records`, command: 'ALL', role: 'authenticated', using: 'user_id = auth.uid()', withCheck: 'user_id = auth.uid()' });
        break;
    }
  };

  const generatedSQL = `CREATE POLICY "${newPolicy.name || 'name'}"\nON public."${newPolicy.table || 'table'}"\nFOR ${newPolicy.command}\nTO ${newPolicy.role}\nUSING (${newPolicy.using || 'true'})${newPolicy.withCheck ? `\nWITH CHECK (${newPolicy.withCheck})` : ''};`;

  return (
    <div className="flex flex-col h-full bg-[#FAFBFC] overflow-hidden">
      {/* Notifications */}
      {(error || successMsg) && (
        <div className={`fixed top-8 left-1/2 -translate-x-1/2 z-[400] p-5 rounded-3xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-top-4 ${error ? 'bg-rose-600 text-white' : 'bg-emerald-600 text-white'}`}>
          {error ? <AlertCircle size={20} /> : <CheckCircle2 size={20} />}
          <span className="text-sm font-black tracking-tight">{error || successMsg}</span>
          <button onClick={() => { setError(null); setSuccessMsg(null); }} className="ml-4 opacity-50 hover:opacity-100"><X size={16} /></button>
        </div>
      )}

      <header className="px-10 py-10 bg-white border-b border-slate-200 flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center gap-6">
          <div className="w-16 h-16 bg-slate-900 text-white rounded-[1.8rem] flex items-center justify-center shadow-2xl shadow-slate-200">
            <Shield size={32} />
          </div>
          <div>
            <h1 className="text-4xl font-black text-slate-900 tracking-tighter leading-none">Access Control</h1>
            <p className="text-slate-400 font-bold uppercase tracking-widest text-[10px] mt-2">Grouped Security Policies</p>
          </div>
        </div>
        <button 
          onClick={() => {
            setIsEditing(false);
            setNewPolicy({ name: '', table: tables[0]?.name || '', command: 'SELECT', role: 'public', using: 'true', withCheck: '', oldName: '' });
            setShowModal(true);
          }} 
          className="bg-indigo-600 text-white px-8 py-4 rounded-[1.5rem] font-black flex items-center gap-3 hover:bg-indigo-700 transition-all shadow-xl shadow-indigo-100 active:scale-95"
        >
          <Plus size={24} /> CREATE POLICY
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-10">
        <div className="max-w-6xl mx-auto space-y-12">
          {/* Summary Banner */}
          <div className="bg-indigo-600 rounded-[3rem] p-12 text-white flex items-center gap-10 relative overflow-hidden shadow-2xl shadow-indigo-100">
            <div className="absolute top-0 right-0 p-12 opacity-10"><Shield size={240} /></div>
            <div className="w-24 h-24 bg-white/20 rounded-[2.5rem] backdrop-blur-md flex items-center justify-center shrink-0">
              <Zap size={48} className="text-white" />
            </div>
            <div className="relative z-10">
              <h4 className="text-3xl font-black tracking-tight mb-2">Policy Isolation Layer</h4>
              <p className="text-indigo-100 text-lg font-medium leading-relaxed max-w-3xl">Manage row-level permissions grouped by data entity. Policies ensure that users can only access the rows intended for their role persona.</p>
            </div>
          </div>

          <div className="space-y-8">
            <div className="flex items-center justify-between px-4">
              <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.4em]">Tables with Policies ({Object.keys(groupedPolicies).length})</h3>
            </div>

            {loading ? (
              <div className="flex flex-col items-center justify-center py-40 text-slate-300 gap-6">
                <Loader2 className="animate-spin text-indigo-600" size={48} />
                <span className="text-xs font-black uppercase tracking-widest">Compiling Catalog...</span>
              </div>
            ) : Object.keys(groupedPolicies).length === 0 ? (
              <div className="bg-white border-4 border-dashed border-slate-100 rounded-[4rem] p-32 text-center flex flex-col items-center shadow-sm">
                <Unlock className="text-slate-100 mb-8" size={120} />
                <h4 className="text-2xl font-black text-slate-300 tracking-tight uppercase tracking-[0.1em]">No Active Policies</h4>
                <p className="text-slate-400 mt-4 font-medium max-w-sm">RLS is disabled across all tables. All data is currently public unless restricted by grants.</p>
                <button 
                  onClick={() => setShowModal(true)} 
                  className="mt-10 bg-slate-900 text-white px-10 py-4 rounded-[1.5rem] font-black text-xs uppercase tracking-widest hover:bg-slate-800 transition-all active:scale-95"
                >
                  Create First Policy
                </button>
              </div>
            ) : (
              <div className="space-y-10 pb-20">
                {/* Fixed type errors by casting Object.entries to [string, any[]][] to avoid unknown inference */}
                {(Object.entries(groupedPolicies) as [string, any[]][]).map(([tableName, tablePolicies]) => (
                  <div key={tableName} className="bg-white border border-slate-200 rounded-[3rem] overflow-hidden shadow-sm hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-500">
                    {/* Table Header */}
                    <button 
                      onClick={() => toggleTable(tableName)}
                      className="w-full flex items-center justify-between p-10 hover:bg-slate-50/50 transition-colors text-left border-b border-slate-100"
                    >
                      <div className="flex items-center gap-6">
                        <div className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center shadow-inner">
                          <Code size={24} />
                        </div>
                        <div>
                          <h4 className="text-2xl font-black text-slate-900 tracking-tight">public.{tableName}</h4>
                          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{tablePolicies.length} Active Policies</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className={`w-8 h-8 rounded-full flex items-center justify-center transition-transform duration-300 ${expandedTables.has(tableName) ? 'rotate-180 bg-slate-900 text-white' : 'bg-slate-100 text-slate-400'}`}>
                          <ChevronDown size={20} />
                        </span>
                      </div>
                    </button>

                    {/* Policy List (Expandable) */}
                    {expandedTables.has(tableName) && (
                      <div className="p-10 space-y-6 bg-slate-50/30 animate-in slide-in-from-top-2 duration-300">
                        {tablePolicies.map((p, i) => {
                          const roles = safeRoles(p.roles);
                          return (
                            <div key={i} className="bg-white border border-slate-200 rounded-[2.5rem] p-8 hover:border-indigo-300 transition-all group shadow-sm">
                              <div className="flex items-center justify-between mb-8">
                                <div className="flex items-center gap-6">
                                  <div className="w-12 h-12 bg-slate-50 text-slate-300 rounded-xl flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-all duration-500">
                                    <Lock size={20} />
                                  </div>
                                  <div>
                                    <h5 className="text-lg font-black text-slate-900 group-hover:text-indigo-600 transition-colors">{p.policyname}</h5>
                                    <div className="flex items-center gap-3 mt-1">
                                      <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{p.cmd}</span>
                                      <span className="w-1.5 h-1.5 bg-slate-200 rounded-full" />
                                      <div className="flex items-center gap-1.5">
                                        {roles.includes('authenticated') ? <Users size={12} className="text-indigo-400" /> : roles.includes('anon') ? <User size={12} className="text-slate-400" /> : <Globe size={12} className="text-emerald-400" />}
                                        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{roles.join(', ')}</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                   <button onClick={() => openDuplicate(p)} title="Duplicate Policy" className="p-3 text-slate-200 hover:text-indigo-600 hover:bg-indigo-50 rounded-2xl transition-all">
                                     <Copy size={20} />
                                   </button>
                                   <button onClick={() => handleEdit(p)} title="Edit Policy" className="p-3 text-slate-200 hover:text-indigo-600 hover:bg-indigo-50 rounded-2xl transition-all">
                                     <Edit2 size={20} />
                                   </button>
                                   <button onClick={() => handleDelete(p.tablename, p.policyname)} title="Delete Policy" className="p-3 text-slate-200 hover:text-rose-600 hover:bg-rose-50 rounded-2xl transition-all">
                                     <Trash2 size={20} />
                                   </button>
                                </div>
                              </div>
                              
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="bg-slate-50 rounded-2xl p-5 border border-slate-100 flex flex-col gap-2">
                                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><Eye size={12} /> Row Visibility</span>
                                  <code className="text-[11px] font-mono text-slate-700 break-all">{p.qual || 'true'}</code>
                                </div>
                                <div className="bg-slate-50 rounded-2xl p-5 border border-slate-100 flex flex-col gap-2">
                                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"><Edit2 size={12} /> Validation</span>
                                  <code className="text-[11px] font-mono text-slate-700 break-all">{p.with_check || 'null'}</code>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* POLICY EDITOR MODAL */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-2xl z-[300] flex items-center justify-center p-8 overflow-y-auto animate-in fade-in duration-300">
          <div className="bg-white rounded-[4rem] w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl animate-in zoom-in-95 duration-500 border border-slate-200">
            <header className="p-12 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-8">
                <div className="w-16 h-16 bg-slate-900 rounded-[2rem] flex items-center justify-center text-white shadow-2xl">
                  {isEditing ? <Edit2 size={32} /> : <Shield size={32} />}
                </div>
                <div>
                  <h3 className="text-4xl font-black text-slate-900 tracking-tighter">{isEditing ? 'Refine Policy' : 'Policy Architect'}</h3>
                  <p className="text-slate-400 font-bold uppercase tracking-widest text-[10px] mt-1">{isEditing ? `Modifying "${newPolicy.oldName}"` : 'Design isolated row access without SQL'}</p>
                </div>
              </div>
              <button onClick={() => setShowModal(false)} className="p-4 hover:bg-slate-200 rounded-full transition-all text-slate-400 active:scale-90">
                <X size={32} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto p-12 flex flex-col lg:flex-row gap-12">
              <div className="flex-1 space-y-10">
                {!isEditing && (
                  <div className="space-y-4">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Accelerators (Templates)</label>
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        { id: 'read_all', label: 'Public Read', desc: 'Allow read access to everyone.' },
                        { id: 'auth_all', label: 'Auth CRUD', desc: 'Full access to logged-in users.' },
                        { id: 'user_own', label: 'Owner Only', desc: 'Users only see their own rows.' },
                        { id: 'user_manage', label: 'Owner CRUD', desc: 'Full control over own data.' }
                      ].map(tpl => (
                        <button key={tpl.id} onClick={() => applyTemplate(tpl.id)} className="p-5 border border-slate-200 rounded-[1.8rem] text-left hover:border-indigo-600 hover:bg-indigo-50 transition-all flex flex-col gap-2 group active:scale-[0.98]">
                          <span className="text-[11px] font-black text-slate-900 uppercase group-hover:text-indigo-600 transition-colors">{tpl.label}</span>
                          <p className="text-[10px] text-slate-400 font-medium leading-tight">{tpl.desc}</p>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-8">
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Target Table</label>
                    <select 
                      value={newPolicy.table} 
                      onChange={(e) => setNewPolicy({ ...newPolicy, table: e.target.value })} 
                      disabled={isEditing}
                      className={`w-full bg-slate-100 border-none rounded-2xl py-5 px-6 text-sm font-black text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all ${isEditing ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      {tables.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Policy Identity</label>
                    <input 
                      value={newPolicy.name} 
                      onChange={(e) => setNewPolicy({ ...newPolicy, name: e.target.value })} 
                      className="w-full bg-slate-100 border-none rounded-2xl py-5 px-6 text-sm font-bold text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all" 
                      placeholder="e.g. read_access_for_public" 
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-8">
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Command Vector</label>
                    <div className="flex gap-2">
                      {['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'].map(cmd => (
                        <button key={cmd} onClick={() => setNewPolicy({ ...newPolicy, command: cmd })} className={`flex-1 py-3.5 text-[9px] font-black rounded-xl border transition-all active:scale-95 ${newPolicy.command === cmd ? 'bg-slate-900 text-white border-slate-900 shadow-lg' : 'bg-white text-slate-400 border-slate-200'}`}>{cmd}</button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-3">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Role Persona</label>
                    <div className="flex gap-2">
                      {['public', 'authenticated', 'anon'].map(role => (
                        <button key={role} onClick={() => setNewPolicy({ ...newPolicy, role })} className={`flex-1 py-3.5 text-[9px] font-black rounded-xl border transition-all active:scale-95 ${newPolicy.role === role ? 'bg-indigo-600 text-white border-indigo-600 shadow-lg' : 'bg-white text-slate-400 border-slate-200'}`}>{role.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="space-y-2">
                    <div className="flex justify-between items-center px-1">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Visibility Condition (USING)</label>
                      <button onClick={() => setNewPolicy({ ...newPolicy, using: 'auth.uid() = user_id' })} className="text-[9px] font-black text-indigo-600 hover:text-indigo-800 transition-colors uppercase tracking-widest">Apply ID Sync</button>
                    </div>
                    <textarea 
                      value={newPolicy.using} 
                      onChange={(e) => setNewPolicy({ ...newPolicy, using: e.target.value })} 
                      className="w-full bg-slate-900 text-emerald-400 p-6 rounded-[2rem] font-mono text-sm h-32 outline-none border-2 border-transparent focus:border-indigo-500/30 transition-all resize-none shadow-inner" 
                      placeholder="e.g. true"
                    />
                  </div>
                  
                  {['INSERT', 'UPDATE', 'ALL'].includes(newPolicy.command) && (
                    <div className="space-y-2">
                      <div className="flex justify-between items-center px-1">
                        <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Mutation Validation (WITH CHECK)</label>
                        <button onClick={() => setNewPolicy({ ...newPolicy, withCheck: 'auth.uid() = user_id' })} className="text-[9px] font-black text-indigo-600 hover:text-indigo-800 transition-colors uppercase tracking-widest">Apply ID Sync</button>
                      </div>
                      <textarea 
                        value={newPolicy.withCheck} 
                        onChange={(e) => setNewPolicy({ ...newPolicy, withCheck: e.target.value })} 
                        className="w-full bg-slate-900 text-amber-400 p-6 rounded-[2rem] font-mono text-sm h-32 outline-none border-2 border-transparent focus:border-indigo-500/30 transition-all resize-none shadow-inner" 
                        placeholder="e.g. auth.uid() = user_id"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Sidebar: SQL Preview */}
              <div className="lg:w-96 space-y-6">
                <div className="bg-slate-950 rounded-[3rem] p-8 flex flex-col gap-6 h-fit sticky top-0 shadow-2xl border border-white/5">
                  <div className="flex items-center gap-3 text-white border-b border-white/10 pb-6">
                    <Code size={20} className="text-indigo-400" />
                    <span className="font-black text-xs uppercase tracking-[0.2em]">Compiled Manifest</span>
                  </div>
                  <pre className="text-[11px] font-mono text-slate-400 leading-relaxed overflow-x-auto whitespace-pre-wrap py-2">
                    {generatedSQL}
                  </pre>
                  <div className="mt-4 pt-6 border-t border-white/10 flex flex-col gap-4">
                    <div className="p-4 bg-indigo-500/10 rounded-2xl border border-indigo-500/20">
                      <p className="text-[10px] text-indigo-300 font-bold leading-relaxed">
                        <Zap size={10} className="inline mr-1 mb-1" /> RLS automatically injects these filters into every query reaching the table.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <footer className="p-12 border-t border-slate-100 bg-slate-50/50 flex gap-6">
              <button onClick={() => setShowModal(false)} className="flex-1 py-7 text-slate-400 font-black uppercase tracking-widest text-xs hover:bg-slate-100 rounded-3xl transition-all">Abort</button>
              <button 
                onClick={handleCreateOrUpdate} 
                disabled={executing || !newPolicy.name} 
                className="flex-[3] py-7 bg-indigo-600 text-white font-black rounded-[2.2rem] shadow-2xl shadow-indigo-200 uppercase tracking-[0.2em] text-xs flex items-center justify-center gap-4 hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50"
              >
                {executing ? <Loader2 size={18} className="animate-spin" /> : <><CheckCircle2 size={18} /> {isEditing ? 'UPDATE SECURITY PLAN' : 'COMMIT SECURITY PLAN'}</>}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* DUPLICATE POLICY MODAL */}
      {showDuplicateModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-2xl z-[350] flex items-center justify-center p-8 animate-in fade-in duration-300">
          <div className="bg-white rounded-[3.5rem] w-full max-w-lg p-12 shadow-2xl animate-in zoom-in-95 border border-slate-200">
            <div className="w-20 h-20 bg-indigo-50 text-indigo-600 rounded-[2rem] flex items-center justify-center mb-8 shadow-inner">
              <Copy size={32} />
            </div>
            <h3 className="text-3xl font-black text-slate-900 tracking-tighter mb-4">Duplicate Policy</h3>
            <p className="text-slate-500 mb-10 font-medium">Clone the security logic of "{selectedPolicyToDuplicate?.policyname}" to another table.</p>
            
            <div className="space-y-3 mb-10">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">Target Table</label>
              <select 
                value={duplicateTargetTable} 
                onChange={(e) => setDuplicateTargetTable(e.target.value)}
                className="w-full bg-slate-100 border-none rounded-2xl py-5 px-6 text-sm font-black text-slate-900 outline-none focus:ring-4 focus:ring-indigo-500/10 transition-all"
              >
                {tables.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
            </div>

            <div className="flex gap-4">
              <button onClick={() => setShowDuplicateModal(false)} className="flex-1 py-6 text-slate-400 font-black uppercase tracking-widest text-xs">Cancel</button>
              <button 
                onClick={handleDuplicate} 
                disabled={executing}
                className="flex-[2] py-6 bg-indigo-600 text-white font-black rounded-[2rem] shadow-xl uppercase tracking-widest text-xs flex items-center justify-center gap-3 active:scale-95"
              >
                {executing ? <Loader2 size={18} className="animate-spin" /> : 'Confirm Clone'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RLSManager;
