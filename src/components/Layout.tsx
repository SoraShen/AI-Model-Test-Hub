import React from 'react';
import { useAuth } from '../context/AuthContext';
import { translations, useI18n } from '../context/I18nContext';
import { Brain, History, Settings, LogOut, Globe, FlaskConical, Bot } from 'lucide-react';
import { motion } from 'motion/react';

type Tab = 'test' | 'history' | 'agent' | 'models';

interface LayoutProps {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  children: React.ReactNode;
}

export default function Layout({ activeTab, setActiveTab, children }: LayoutProps) {
  const { user, logout } = useAuth();
  const { lang, setLang, t } = useI18n();

  const menuItems: Array<{ id: Tab; icon: typeof FlaskConical; label: string }> = [
    { id: 'test', icon: FlaskConical, label: t('test') },
    { id: 'agent', icon: Bot, label: t('agent') },
  ];

  if (user?.role === 'admin') {
    menuItems.push({ id: 'history', icon: History, label: t('history') });
    menuItems.push({ id: 'models', icon: Settings, label: t('models') });
  }

  // If a non-admin lands on a tab that's not visible to them (e.g. history),
  // bounce them back to the default Test tab.
  React.useEffect(() => {
    if (!menuItems.some((m) => m.id === activeTab)) {
      setActiveTab('test');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.role, activeTab]);

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-slate-200 flex flex-col pt-6">
        <div className="px-6 mb-10 flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-600/20">
            <Brain className="text-white" size={20} />
          </div>
          <span className="text-slate-900 font-bold text-xl tracking-tight">AI Bench</span>
        </div>

        <nav className="flex-1 px-4 space-y-1">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id as Tab)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all ${
                activeTab === item.id 
                  ? 'bg-slate-100 text-slate-900 shadow-sm ring-1 ring-slate-200' 
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              <item.icon size={18} className="opacity-80" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-4">
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider">
              <Globe size={12} className="text-slate-500" />
              <button 
                onClick={() => setLang('en')}
                className={lang === 'en' ? 'text-indigo-400' : 'text-slate-500'}
              >EN</button>
              <span className="text-slate-300">|</span>
              <button 
                onClick={() => setLang('zh')}
                className={lang === 'zh' ? 'text-indigo-400' : 'text-slate-500'}
              >中文</button>
            </div>
          </div>

          <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
            <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-bold text-slate-700">
              {user?.username[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-900 truncate">{user?.username}</p>
              <p className="text-[10px] text-slate-500 truncate uppercase tracking-tighter">{user?.role}</p>
            </div>
            <button 
              onClick={logout}
              className="text-slate-500 hover:text-red-600 transition-colors"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 border-b border-slate-200 flex items-center justify-between px-8 bg-white/70 backdrop-blur-sm sticky top-0 z-10">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span>Platform</span>
            <span className="text-slate-300">/</span>
            <span className="text-slate-900 font-medium uppercase tracking-wider text-xs">
              {t(activeTab as keyof typeof translations)}
            </span>
          </div>
          <div className="flex items-center gap-4">
             <span className="px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 text-[10px] font-bold uppercase tracking-wider border border-indigo-500/20">
               {user?.role} Access
             </span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-8 bg-slate-50">
          <div className="max-w-7xl mx-auto h-full">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="h-full"
            >
              {children}
            </motion.div>
          </div>
        </div>

        {/* Footer */}
        <footer className="h-8 bg-white border-t border-slate-200 px-8 flex items-center justify-between text-[10px] text-slate-500">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
              Status: Operational
            </div>
          </div>
          <div>v1.0.2 Stable</div>
        </footer>
      </main>
    </div>
  );
}
