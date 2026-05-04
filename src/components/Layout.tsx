import React from 'react';
import { useAuth } from '../context/AuthContext';
import { translations, useI18n } from '../context/I18nContext';
import {
  Brain,
  History,
  Settings,
  LogOut,
  Globe,
  FlaskConical,
  Bot,
  Menu,
  X,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

type Tab = 'test' | 'history' | 'agent' | 'models';

interface LayoutProps {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  children: React.ReactNode;
}

export default function Layout({ activeTab, setActiveTab, children }: LayoutProps) {
  const { user, logout } = useAuth();
  const { lang, setLang, t } = useI18n();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

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

  // Close the mobile drawer when switching to a desktop viewport so it doesn't
  // stick around invisibly.
  React.useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = () => {
      if (mq.matches) setDrawerOpen(false);
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // Lock body scroll while the mobile drawer is open.
  React.useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  const handlePickTab = (id: Tab) => {
    setActiveTab(id);
    setDrawerOpen(false);
  };

  const sidebarBody = (
    <>
      <div className="px-6 mb-8 md:mb-10 flex items-center gap-3">
        <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-600/20">
          <Brain className="text-white" size={20} />
        </div>
        <span className="text-slate-900 font-bold text-xl tracking-tight">AI Bench</span>
      </div>

      <nav className="flex-1 px-4 space-y-1">
        {menuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handlePickTab(item.id as Tab)}
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
            >
              EN
            </button>
            <span className="text-slate-300">|</span>
            <button
              onClick={() => setLang('zh')}
              className={lang === 'zh' ? 'text-indigo-400' : 'text-slate-500'}
            >
              中文
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
          <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-bold text-slate-700">
            {user?.username[0].toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-slate-900 truncate">{user?.username}</p>
            <p className="text-[10px] text-slate-500 truncate uppercase tracking-tighter">
              {user?.role}
            </p>
          </div>
          <button
            onClick={logout}
            className="text-slate-500 hover:text-red-600 transition-colors"
            aria-label="Log out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex min-h-dvh md:h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 bg-white border-r border-slate-200 flex-col pt-6">
        {sidebarBody}
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <>
            <motion.div
              key="backdrop"
              className="md:hidden fixed inset-0 bg-slate-900/40 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setDrawerOpen(false)}
            />
            <motion.aside
              key="drawer"
              className="md:hidden fixed top-0 left-0 bottom-0 w-72 max-w-[85vw] bg-white border-r border-slate-200 z-50 flex flex-col pt-6 pb-safe pl-safe shadow-2xl"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'tween', duration: 0.22 }}
            >
              <button
                onClick={() => setDrawerOpen(false)}
                className="absolute top-3 right-3 p-2 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                aria-label="Close menu"
              >
                <X size={18} />
              </button>
              {sidebarBody}
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Mobile top bar (hidden on md+) */}
        <header className="md:hidden h-14 border-b border-slate-200 flex items-center justify-between px-4 bg-white/90 backdrop-blur sticky top-0 z-20 pt-safe">
          <button
            onClick={() => setDrawerOpen(true)}
            className="p-2 -ml-2 rounded-lg text-slate-700 hover:bg-slate-100 active:bg-slate-200"
            aria-label="Open menu"
          >
            <Menu size={22} />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center shadow-md shadow-indigo-600/20">
              <Brain className="text-white" size={16} />
            </div>
            <span className="text-slate-900 font-bold text-base tracking-tight">AI Bench</span>
          </div>
          <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-500 bg-indigo-500/10 px-2 py-1 rounded border border-indigo-500/20">
            {user?.role}
          </span>
        </header>

        {/* Desktop top bar */}
        <header className="hidden md:flex h-16 border-b border-slate-200 items-center justify-between px-8 bg-white/70 backdrop-blur-sm sticky top-0 z-10">
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

        <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-8 bg-slate-50">
          <div className="max-w-7xl mx-auto flex min-h-full flex-col">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="min-h-0 flex flex-1 flex-col"
            >
              {children}
            </motion.div>
          </div>
        </div>

        {/* Footer (hidden on small screens to save vertical space) */}
        <footer className="hidden md:flex h-8 bg-white border-t border-slate-200 px-8 items-center justify-between text-[10px] text-slate-500">
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
