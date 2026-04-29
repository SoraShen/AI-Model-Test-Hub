import React, { useState, useEffect } from 'react';
import { useI18n } from '../context/I18nContext';
import { Calendar, User, Cpu, ChevronRight, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function TabHistory() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [history, setHistory] = useState<any[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch('/api/history').then(res => res.json()).then(setHistory);
  }, []);

  const filteredHistory = history.filter(item => 
    item.model_name.toLowerCase().includes(filter.toLowerCase()) ||
    item.input.toLowerCase().includes(filter.toLowerCase()) ||
    item.username.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-8">
        <h2 className="text-lg font-bold text-slate-900 tracking-tight uppercase">Activity Stream</h2>
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
          <input
            type="text"
            placeholder="Search records..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full bg-white border border-slate-200 rounded-lg py-2 pl-10 pr-4 text-sm text-slate-900 focus:outline-none focus:ring-2 ring-indigo-200 transition-all"
          />
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-6 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('timestamp')}</th>
              {user?.role === 'admin' && <th className="px-6 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('user')}</th>}
              <th className="px-6 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('models')}</th>
              <th className="px-6 py-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Dataset Trace</th>
              <th className="px-6 py-4"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {filteredHistory.map((item) => (
              <tr key={item.id} className="hover:bg-slate-50 transition-colors group">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                    <Calendar size={12} className="text-slate-600" />
                    {new Date(item.timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                  </div>
                </td>
                {user?.role === 'admin' && (
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2 text-sm text-slate-900 font-medium">
                      <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-700">
                        {item.username[0].toUpperCase()}
                      </div>
                      {item.username}
                    </div>
                  </td>
                )}
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider border ${
                      item.type === 'LLM' 
                        ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' 
                        : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                    }`}>
                      {item.type}
                    </span>
                    <span className="text-sm text-slate-800">{item.model_name}</span>
                  </div>
                </td>
                <td className="px-6 py-4 max-w-sm">
                  <div className="space-y-1">
                    <p className="text-xs text-slate-500 line-clamp-1 italic font-mono truncate cursor-help" title={item.input}>
                      {item.input}
                    </p>
                    <p className="text-sm text-slate-700 line-clamp-1 font-mono truncate" title={item.output}>
                      {item.output}
                    </p>
                  </div>
                </td>
                <td className="px-6 py-4 text-right">
                   <div className="flex items-center justify-end gap-2">
                      <span className="text-[10px] text-slate-600 font-mono">#ID:{item.id}</span>
                      <ChevronRight size={16} className="text-slate-400 group-hover:text-slate-900 transition-colors" />
                   </div>
                </td>
              </tr>
            ))}
            {filteredHistory.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-24 text-center">
                  <div className="flex flex-col items-center gap-3 text-slate-600 italic">
                    <div className="w-12 h-12 rounded-full border-2 border-slate-200 flex items-center justify-center mb-2">
                       <Search size={24} className="opacity-20" />
                    </div>
                    No evaluation logs recorded
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
