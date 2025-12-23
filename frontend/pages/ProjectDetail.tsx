
import React, { useState, useEffect } from 'react';
import { Shield, Key, Database, Activity, CheckCircle2, Loader2, Server, Settings2, Globe, Lock, Users } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import ProjectSettings from './ProjectSettings';

const ProjectDetail: React.FC<{ projectId: string }> = ({ projectId }) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'settings'>('overview');
  const [stats, setStats] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const token = localStorage.getItem('cascata_token');
        const headers = { 'Authorization': `Bearer ${token}` };
        
        const [statsRes, logsRes, usersRes] = await Promise.all([
            fetch(`/api/data/${projectId}/stats`, { headers }),
            fetch(`/api/data/${projectId}/logs`, { headers }),
            fetch(`/api/data/${projectId}/auth/users`, { headers })
        ]);

        const statsData = await statsRes.json();
        const logsData = await logsRes.json();
        const usersData = await usersRes.json();

        setStats(statsData);
        setLogs(Array.isArray(logsData) ? logsData : []);
        setUsers(Array.isArray(usersData) ? usersData : []);
      } catch (err) {
        console.error('Error fetching dashboard data');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [projectId]);

  // PROCESS LOGS FOR CHART
  const processThroughput = () => {
      const hoursMap = new Map();
      const now = new Date();
      // Initialize last 24 hours
      for(let i=23; i>=0; i--) {
          const d = new Date(now.getTime() - (i * 60 * 60 * 1000));
          const label = d.getHours().toString().padStart(2, '0') + ':00';
          hoursMap.set(label, 0);
      }

      logs.forEach(log => {
          const d = new Date(log.created_at);
          // Check if log is within last 24h
          if ((now.getTime() - d.getTime()) < (24 * 60 * 60 * 1000)) {
              const label = d.getHours().toString().padStart(2, '0') + ':00';
              if (hoursMap.has(label)) {
                  hoursMap.set(label, hoursMap.get(label) + 1);
              }
          }
      });

      return Array.from(hoursMap).map(([name, requests]) => ({ name, requests }));
  };

  // PROCESS USERS FOR CHART
  const processUserGrowth = () => {
      const daysMap = new Map();
      const now = new Date();
      // Last 7 days
      for(let i=6; i>=0; i--) {
          const d = new Date(now.getTime() - (i * 24 * 60 * 60 * 1000));
          const label = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
          daysMap.set(label, 0);
      }

      users.forEach(user => {
          const d = new Date(user.created_at);
          const label = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
          if (daysMap.has(label)) {
              daysMap.set(label, daysMap.get(label) + 1);
          }
      });

      // Cumulative calculation
      let cumulative = 0;
      // Pre-calculate users older than 7 days
      const cutOff = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
      cumulative = users.filter(u => new Date(u.created_at) < cutOff).length;

      return Array.from(daysMap).map(([name, newUsers]) => {
          cumulative += newUsers;
          return { name, total: cumulative };
      });
  };

  const chartData = processThroughput();
  const userChartData = processUserGrowth();

  return (
    <div className="p-8 lg:p-12 max-w-7xl mx-auto w-full space-y-12 pb-40">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-8">
        <div>
          <h1 className="text-5xl font-black text-slate-900 tracking-tighter">{projectId} Instance</h1>
          <div className="flex items-center gap-4 mt-3">
            <span className="font-mono text-xs bg-slate-100 text-slate-500 px-3 py-1.5 rounded-xl font-bold border border-slate-200 uppercase tracking-widest">Isolated Host</span>
            <span className="flex items-center gap-1.5 text-emerald-600 font-black text-[10px] uppercase tracking-widest bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-100">
              <CheckCircle2 size={14} /> System Healthy
            </span>
          </div>
        </div>

        <div className="flex items-center bg-slate-100 p-1.5 rounded-2xl">
          <button onClick={() => setActiveTab('overview')} className={`px-8 py-3 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeTab === 'overview' ? 'bg-white shadow-xl text-indigo-600' : 'text-slate-500'}`}><Activity size={16}/> MONITOR</button>
          <button onClick={() => setActiveTab('settings')} className={`px-8 py-3 text-xs font-black rounded-xl transition-all flex items-center gap-2 ${activeTab === 'settings' ? 'bg-white shadow-xl text-indigo-600' : 'text-slate-500'}`}><Settings2 size={16}/> SETTINGS</button>
        </div>
      </div>

      {activeTab === 'overview' ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <StatCard title="Data Entities" value={loading ? '...' : stats?.tables?.toString() || '0'} icon={<Database className="text-indigo-600" />} label="public" />
            <StatCard title="Auth Records" value={loading ? '...' : stats?.users?.toString() || '0'} icon={<Shield className="text-emerald-500" />} label="auth" />
            <StatCard title="Physical Volume" value={loading ? '...' : stats?.size || '0 MB'} icon={<Server className="text-blue-500" />} label="disk_usage" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
            {/* THROUGHPUT CHART */}
            <div className="border border-slate-200 rounded-[3rem] p-10 bg-white shadow-sm overflow-hidden relative group h-[400px]">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3"><Activity size={24} className="text-indigo-600"/> API Throughput</h3>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">24H Activity</span>
              </div>
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.2}/>
                        <stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fontSize: 10, fill: '#94a3b8', fontWeight: 700}} />
                    <Tooltip contentStyle={{borderRadius: '16px', border: 'none', boxShadow: '0 10px 30px rgba(0,0,0,0.1)', padding: '12px'}} />
                    <Area type="monotone" dataKey="requests" stroke="#4f46e5" fillOpacity={1} fill="url(#colorReq)" strokeWidth={3} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* USERS CHART */}
            <div className="border border-slate-200 rounded-[3rem] p-10 bg-white shadow-sm overflow-hidden relative group h-[400px]">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3"><Users size={24} className="text-emerald-500"/> User Growth</h3>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">7 Day Trend</span>
              </div>
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={userChartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fontSize: 10, fill: '#94a3b8', fontWeight: 700}} />
                    <Tooltip cursor={{fill: '#f8fafc'}} contentStyle={{borderRadius: '16px', border: 'none', boxShadow: '0 10px 30px rgba(0,0,0,0.1)', padding: '12px'}} />
                    <Bar dataKey="total" fill="#10b981" radius={[6, 6, 0, 0]} barSize={40} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="border border-slate-200 rounded-[3rem] p-10 bg-white shadow-sm space-y-10 flex flex-col group">
              <h3 className="text-xl font-black text-slate-900 tracking-tight flex items-center gap-3"><Globe size={24} className="text-indigo-600"/> Infrastructure Manifest</h3>
              <div className="space-y-6 flex-1">
                <ConfigItem label="API Endpoint" value={`http://${window.location.hostname}/api/data/${projectId}`} />
                <ConfigItem label="Database ID" value={`cascata_proj_${projectId.replace(/-/g, '_')}`} />
                <ConfigItem label="Auth Protocol" value="JWT physical isolation" />
              </div>
              
              <div className="p-6 bg-indigo-900 rounded-[2rem] border border-white/10 shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 right-0 p-6 opacity-10"><Lock size={80} /></div>
                <p className="text-[10px] font-black text-indigo-300 uppercase tracking-widest mb-2 relative z-10">Isolation Strategy</p>
                <p className="text-sm text-white font-medium leading-relaxed relative z-10">This instance is running on a dedicated schema with unique cryptographic keys. RLS is enforced at the binary level.</p>
              </div>
          </div>
        </>
      ) : (
        <ProjectSettings projectId={projectId} />
      )}
    </div>
  );
};

const StatCard: React.FC<{ title: string, value: string, icon: React.ReactNode, label: string }> = ({ title, value, icon, label }) => (
  <div className="bg-white border border-slate-200 rounded-[2.5rem] p-10 shadow-sm hover:shadow-2xl hover:shadow-indigo-500/5 transition-all group relative overflow-hidden">
    <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-125 transition-transform duration-500">{icon}</div>
    <div className="flex items-center justify-between mb-6">
      <div className="w-14 h-14 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400 group-hover:bg-indigo-600 group-hover:text-white transition-all duration-300 border border-slate-100 shadow-inner">
        {icon}
      </div>
      <span className="text-[10px] font-black text-slate-300 uppercase tracking-[0.2em]">{label}</span>
    </div>
    <div className="text-5xl font-black text-slate-900 mb-2 tracking-tighter">{value}</div>
    <div className="text-[11px] font-black text-slate-400 uppercase tracking-widest">{title}</div>
  </div>
);

const ConfigItem: React.FC<{ label: string, value: string }> = ({ label, value }) => (
  <div className="space-y-2">
    <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-1">{label}</span>
    <div className="bg-slate-50 border border-slate-100 rounded-2xl px-5 py-3.5 font-mono text-xs text-slate-600 truncate font-bold">
      {value}
    </div>
  </div>
);

export default ProjectDetail;
