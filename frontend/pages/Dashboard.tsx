import React, { useState, useEffect } from 'react';
import { Plus, Search, ExternalLink, Activity, Database, Clock, MoreVertical, Terminal, Loader2, Server, Key, Shield, Trash2, AlertTriangle } from 'lucide-react';
import { Project } from '../types';

interface DashboardProps {
  onSelectProject: (id: string) => void;
}

const Dashboard: React.FC<DashboardProps> = ({ onSelectProject }) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newProject, setNewProject] = useState({ name: '', slug: '' });
  const [deletingProject, setDeletingProject] = useState<string | null>(null);

  const fetchProjects = async () => {
    try {
      const response = await fetch('/api/control/projects', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
      });
      const data = await response.json();
      setProjects(data);
    } catch (err) {
      console.error('Project Registry Sync Failure');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProjects(); }, []);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await fetch('/api/control/projects', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('cascata_token')}`
        },
        body: JSON.stringify(newProject),
      });
      if (response.ok) {
        setShowCreateModal(false);
        setNewProject({ name: '', slug: '' });
        fetchProjects();
      }
    } catch (err) {
      console.error('Provisioning engine failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteProject = async (slug: string) => {
    if (!confirm(`DANGER: Destroy project "${slug}"?\nThis will permanently delete the database and all files.`)) return;
    setLoading(true);
    try {
        await fetch(`/api/control/projects/${slug}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('cascata_token')}` }
        });
        fetchProjects();
    } catch (e) {
        alert("Delete failed.");
    } finally {
        setLoading(false);
    }
  };

  return (
    <div className="p-12 lg:p-20 max-w-7xl mx-auto w-full min-h-screen">
      <div className="flex flex-col md:flex-row md:items-end justify-between mb-20 gap-8">
        <div>
          <h1 className="text-6xl font-black text-slate-900 tracking-tighter mb-4">Registry</h1>
          <p className="text-slate-400 text-xl font-medium max-w-2xl leading-relaxed">Infrastructure-as-a-Code orchestration for multi-tenant PostgreSQL environments.</p>
        </div>
        <button 
          onClick={() => setShowCreateModal(true)} 
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-10 py-5 rounded-[1.8rem] font-black flex items-center gap-3 transition-all shadow-[0_20px_40px_rgba(79,70,229,0.3)] hover:-translate-y-1 active:scale-95 text-lg"
        >
          <Plus size={28} /> Provision Instance
        </button>
      </div>

      {loading && projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-40 text-slate-400">
          <Loader2 className="animate-spin mb-6 text-indigo-600" size={64} />
          <p className="font-black text-lg uppercase tracking-widest">Synchronizing Registry...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10 pb-40">
          {projects.map((project) => (
            <div key={project.id} className="relative group">
                <ProjectCard project={project} onClick={() => onSelectProject(project.slug)} />
                <button 
                    onClick={(e) => { e.stopPropagation(); handleDeleteProject(project.slug); }}
                    className="absolute top-6 right-6 p-3 bg-white text-slate-300 hover:text-rose-600 rounded-full shadow-sm hover:shadow-md transition-all opacity-0 group-hover:opacity-100 z-50"
                    title="Destroy Instance"
                >
                    <Trash2 size={18} />
                </button>
            </div>
          ))}
          
          <button 
            onClick={() => setShowCreateModal(true)}
            className="border-4 border-dashed border-slate-200 rounded-[3rem] p-12 flex flex-col items-center justify-center text-slate-300 hover:border-indigo-400 hover:text-indigo-500 hover:bg-indigo-50/50 transition-all group overflow-hidden relative"
          >
            <div className="w-24 h-24 rounded-[2rem] border-4 border-dashed border-slate-200 flex items-center justify-center mb-8 group-hover:border-indigo-400 group-hover:scale-110 transition-all duration-500">
              <Plus size={48} />
            </div>
            <span className="font-black text-2xl tracking-tighter">New Instance</span>
            <p className="text-sm font-bold uppercase tracking-widest mt-2 opacity-60">Physical Schema Isolation</p>
          </button>
        </div>
      )}

      {/* Provisioning Modal (Robust) */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-2xl z-[100] flex items-center justify-center p-8 animate-in fade-in duration-500">
          <div className="bg-white rounded-[4rem] w-full max-w-xl p-16 shadow-[0_0_150px_rgba(0,0,0,0.5)] border border-slate-100 animate-in zoom-in-95">
            <div className="w-20 h-20 bg-indigo-600 rounded-[2rem] flex items-center justify-center text-white mb-10 shadow-2xl">
              <Server size={32} />
            </div>
            <h2 className="text-4xl font-black text-slate-900 mb-4 tracking-tighter">New Infrastructure</h2>
            <p className="text-slate-500 mb-12 text-lg font-medium leading-relaxed">Creating a new project will provision a dedicated PostgreSQL database and generate unique service keys.</p>
            
            <form onSubmit={handleCreateProject} className="space-y-8">
              <div className="space-y-3">
                <label className="text-[11px] font-black text-slate-400 uppercase tracking-[0.3em] ml-1">Instance Name</label>
                <input 
                  type="text" 
                  value={newProject.name}
                  onChange={(e) => setNewProject({...newProject, name: e.target.value})}
                  className="w-full bg-slate-100 border-none rounded-3xl py-5 px-8 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 text-xl font-bold text-slate-900 placeholder:text-slate-300"
                  placeholder="App Production"
                  required
                />
              </div>
              <div className="space-y-3">
                <label className="text-[11px] font-black text-slate-400 uppercase tracking-[0.3em] ml-1">Global Slug (ID)</label>
                <div className="relative">
                  <Terminal className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
                  <input 
                    type="text" 
                    value={newProject.slug}
                    onChange={(e) => setNewProject({...newProject, slug: e.target.value.toLowerCase().replace(/ /g, '-')})}
                    className="w-full bg-slate-100 border-none rounded-3xl py-5 pl-16 pr-8 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 font-mono text-lg text-indigo-600"
                    placeholder="my-saas-infra"
                    required
                  />
                </div>
              </div>
              
              <div className="flex gap-6 pt-8">
                <button type="button" onClick={() => setShowCreateModal(false)} className="flex-1 py-6 text-slate-400 font-black hover:bg-slate-100 rounded-3xl transition-all uppercase tracking-widest text-xs">Abort</button>
                <button 
                   type="submit" 
                   disabled={loading}
                   className="flex-[2] py-6 bg-indigo-600 text-white font-black rounded-3xl shadow-2xl shadow-indigo-500/30 hover:bg-indigo-700 transition-all uppercase tracking-[0.2em] text-xs flex items-center justify-center gap-3"
                >
                  {loading ? <Loader2 size={18} className="animate-spin" /> : 'Provision Architecture'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

const ProjectCard: React.FC<{ project: Project, onClick: () => void }> = ({ project, onClick }) => {
  return (
    <div 
      onClick={onClick}
      className="group relative bg-white border-2 border-slate-100 rounded-[3.5rem] p-12 hover:shadow-[0_40px_80px_rgba(0,0,0,0.08)] hover:border-indigo-200 transition-all cursor-pointer flex flex-col h-[480px] overflow-hidden"
    >
      <div className="absolute top-0 right-0 p-10 opacity-5 group-hover:scale-150 group-hover:rotate-12 transition-all duration-700">
        <Database size={180} />
      </div>
      
      <div className="flex items-start justify-between mb-12 relative z-10">
        <div className="w-20 h-20 rounded-[1.8rem] bg-slate-900 flex items-center justify-center text-white group-hover:bg-indigo-600 transition-all duration-500 shadow-2xl group-hover:shadow-indigo-500/40">
          <Database size={32} />
        </div>
        <div className="flex items-center gap-2 px-4 py-2 bg-emerald-50 rounded-full border border-emerald-100">
          <div className={`w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse`}></div>
          <span className="text-[10px] font-black uppercase tracking-widest text-emerald-600">Active</span>
        </div>
      </div>
      
      <div className="relative z-10">
        <h3 className="text-4xl font-black text-slate-900 group-hover:text-indigo-600 transition-colors mb-2 tracking-tighter leading-none">
          {project.name}
        </h3>
        <p className="text-sm text-slate-400 font-mono bg-slate-50 px-3 py-1.5 rounded-xl inline-block w-fit mt-4 border border-slate-100">
          /{project.slug}
        </p>
      </div>
      
      <div className="mt-auto space-y-5 relative z-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center text-indigo-600"><Key size={14}/></div>
             <span className="text-xs font-black text-slate-400 uppercase tracking-widest">Isolated Security</span>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
             <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600"><Shield size={14}/></div>
             <span className="text-xs font-black text-slate-400 uppercase tracking-widest">RLS Enabled</span>
          </div>
        </div>
      </div>

      <div className="mt-10 pt-8 border-t border-slate-100 flex items-center justify-between text-indigo-600 text-sm font-black relative z-10">
        <span className="group-hover:translate-x-3 transition-all duration-500 inline-block uppercase tracking-[0.2em] text-xs">Control Instance</span>
        <div className="w-10 h-10 rounded-full border-2 border-indigo-100 flex items-center justify-center group-hover:bg-indigo-600 group-hover:text-white transition-all">
          <ExternalLink size={18} />
        </div>
      </div>
    </div>
  );
};

export default Dashboard;