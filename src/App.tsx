import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { I18nProvider } from './context/I18nContext';
import Login from './components/Login';
import Layout from './components/Layout';
import TabTest from './components/TabTest';
import TabHistory from './components/TabHistory';
import TabModels from './components/TabModels';
import TabAgent from './components/TabAgent';
import { Loader2 } from 'lucide-react';

function AppContent() {
  const { user, isLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<'test' | 'history' | 'agent' | 'models'>('test');

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <Loader2 className="text-blue-600 animate-spin" size={48} />
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <Layout activeTab={activeTab} setActiveTab={setActiveTab}>
      {activeTab === 'test' && <TabTest />}
      {activeTab === 'history' && <TabHistory />}
      {activeTab === 'agent' && <TabAgent />}
      {activeTab === 'models' && <TabModels />}
    </Layout>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </I18nProvider>
  );
}

