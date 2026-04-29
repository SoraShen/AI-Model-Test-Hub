import React, { useState, useEffect } from 'react';
import { useI18n } from '../context/I18nContext';
import { Plus, Trash2, Globe, Key, Settings2, Pencil } from 'lucide-react';

export default function TabModels() {
  const { t } = useI18n();
  const [models, setModels] = useState<any[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [newModel, setNewModel] = useState({
    name: '',
    type: 'LLM',
    endpoint: '',
    api_key: '',
  });
  const [editModel, setEditModel] = useState({
    name: '',
    type: 'LLM',
    endpoint: '',
    api_key: '',
  });

  const fetchModels = () => {
    fetch('/api/models').then(res => res.json()).then(setModels);
  };

  useEffect(() => {
    fetchModels();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newModel),
    });
    if (res.ok) {
      setIsAdding(false);
      setNewModel({ name: '', type: 'LLM', endpoint: '', api_key: '' });
      fetchModels();
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure?')) return;
    await fetch(`/api/models/${id}`, { method: 'DELETE' });
    fetchModels();
  };

  const startEdit = (model: any) => {
    setEditingId(model.id);
    setEditModel({ name: model.name, type: model.type, endpoint: model.endpoint, api_key: '' });
    setIsAdding(false);
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    const res = await fetch(`/api/models/${editingId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editModel),
    });
    if (res.ok) {
      setEditingId(null);
      setEditModel({ name: '', type: 'LLM', endpoint: '', api_key: '' });
      fetchModels();
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-lg font-bold text-slate-900 tracking-tight uppercase">Infrastructure</h2>
          <p className="text-xs text-slate-500 font-medium">Manage enterprise AI endpoints and authentication credentials.</p>
        </div>
        <button
          onClick={() => setIsAdding(!isAdding)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-lg text-xs font-bold transition-all shadow-lg active:scale-95"
        >
          <Plus size={16} />
          {t('addModel').toUpperCase()}
        </button>
      </div>

      {editingId && (
        <form onSubmit={handleUpdate} className="bg-white border border-emerald-300/40 rounded-xl p-8 space-y-6 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500"></div>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900 tracking-tight uppercase">Edit Model</h3>
              <p className="text-xs text-slate-500 font-medium">
                Leave API Key empty to keep the existing key.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              className="text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors"
            >
              CLOSE
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('modelName')}</label>
              <input
                required
                value={editModel.name}
                onChange={e => setEditModel({ ...editModel, name: e.target.value })}
                className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-slate-900 focus:outline-none focus:ring-2 ring-emerald-200 transition-all"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('modelType')}</label>
              <select
                value={editModel.type}
                onChange={e => setEditModel({ ...editModel, type: e.target.value })}
                className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-slate-900 focus:outline-none focus:ring-2 ring-emerald-200 transition-all font-medium"
              >
                <option value="LLM">Text-to-Text (LLM)</option>
                <option value="ASR">Audio-to-Text / Audio Understanding (ASR)</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('endpoint')}</label>
              <div className="relative">
                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" size={16} />
                <input
                  required
                  value={editModel.endpoint}
                  onChange={e => setEditModel({ ...editModel, endpoint: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg pl-10 pr-4 py-2.5 text-slate-900 focus:outline-none focus:ring-2 ring-emerald-200 font-mono text-xs"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('apiKey')}</label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" size={16} />
                <input
                  type="password"
                  value={editModel.api_key}
                  onChange={e => setEditModel({ ...editModel, api_key: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg pl-10 pr-4 py-2.5 text-slate-900 focus:outline-none focus:ring-2 ring-emerald-200 font-mono text-xs"
                  placeholder="(optional) paste new key to rotate"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-6 border-t border-slate-200">
            <button type="submit" className="bg-emerald-600 hover:bg-emerald-500 text-white px-8 py-2.5 rounded-lg text-xs font-bold shadow-lg transition-all active:scale-95">
              SAVE CHANGES
            </button>
          </div>
        </form>
      )}

      {isAdding && (
        <form onSubmit={handleAdd} className="bg-white border border-indigo-300/40 rounded-xl p-8 space-y-6 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-indigo-600"></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('modelName')}</label>
              <input
                required
                value={newModel.name}
                onChange={e => setNewModel({ ...newModel, name: e.target.value })}
                className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-slate-900 focus:outline-none focus:ring-2 ring-indigo-200 transition-all"
                placeholder="e.g. GPT-4-Turbo (Production)"
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('modelType')}</label>
              <select
                value={newModel.type}
                onChange={e => setNewModel({ ...newModel, type: e.target.value })}
                className="w-full bg-white border border-slate-200 rounded-lg px-4 py-2.5 text-slate-900 focus:outline-none focus:ring-2 ring-indigo-200 transition-all font-medium"
              >
                <option value="LLM">Text-to-Text (LLM)</option>
                <option value="ASR">Audio-to-Text (ASR)</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('endpoint')}</label>
              <div className="relative">
                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" size={16} />
                <input
                  required
                  value={newModel.endpoint}
                  onChange={e => setNewModel({ ...newModel, endpoint: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg pl-10 pr-4 py-2.5 text-slate-900 focus:outline-none focus:ring-2 ring-indigo-200 font-mono text-xs"
                  placeholder="https://api.openai.com/v1..."
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{t('apiKey')}</label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" size={16} />
                <input
                  type="password"
                  required
                  value={newModel.api_key}
                  onChange={e => setNewModel({ ...newModel, api_key: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg pl-10 pr-4 py-2.5 text-slate-900 focus:outline-none focus:ring-2 ring-indigo-200 font-mono text-xs"
                  placeholder="••••••••••••••••"
                />
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-6 border-t border-slate-200">
            <button type="button" onClick={() => setIsAdding(false)} className="px-6 py-2 text-xs font-bold text-slate-500 hover:text-slate-900 transition-colors">CANCEL</button>
            <button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-2.5 rounded-lg text-xs font-bold shadow-lg transition-all active:scale-95">CONFIRM CONFIGURATION</button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {models.map(model => (
          <div key={model.id} className="bg-white border border-slate-200 rounded-xl p-6 relative group transition-all hover:border-slate-300 hover:shadow-sm">
            <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
               <button
                onClick={() => startEdit(model)}
                className="p-2 bg-white text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 hover:text-slate-900 transition-all shadow-sm"
                title="Edit Configuration"
               >
                 <Pencil size={16} />
               </button>
               <button 
                onClick={() => handleDelete(model.id)}
                className="p-2 bg-red-500/10 text-red-400 rounded-lg hover:bg-red-500 hover:text-white transition-all shadow-sm"
                title="Delete Configuration"
               >
                 <Trash2 size={16} />
               </button>
            </div>
            <div className="flex items-center gap-4 mb-6">
              <div className="w-12 h-12 bg-slate-50 rounded-lg flex items-center justify-center border border-slate-200 shadow-inner">
                <Settings2 className="text-slate-500" size={24} />
              </div>
              <div className="min-w-0">
                <h4 className="text-slate-900 font-bold truncate pr-8">{model.name}</h4>
                <span className={`text-[10px] font-bold border px-2 py-0.5 rounded uppercase tracking-wider ${
                  model.type === 'LLM' ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                }`}>
                  {model.type}
                </span>
              </div>
            </div>
            <div className="space-y-4 font-mono">
               <div className="flex flex-col gap-1">
                  <span className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Endpoint</span>
                  <p className="text-xs text-slate-700 truncate bg-slate-50 p-2 rounded border border-slate-200">{model.endpoint}</p>
               </div>
               <div className="flex flex-col gap-1">
                  <span className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">Security Status</span>
                  <div className="flex items-center gap-2 text-[10px] text-slate-500">
                    <Key size={10} />
                    <span className="text-slate-700">ENCRYPTED AT REST</span>
                  </div>
               </div>
            </div>
          </div>
        ))}
        {models.length === 0 && (
          <div className="col-span-full py-20 bg-slate-50 border-2 border-dashed border-slate-200 rounded-xl flex flex-col items-center justify-center text-slate-600">
            <Settings2 size={48} className="opacity-20 mb-4" />
            <span className="text-sm font-medium italic">No AI models configured</span>
          </div>
        )}
      </div>
    </div>
  );
}
