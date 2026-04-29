import React, { createContext, useContext, useState } from 'react';

type Language = 'en' | 'zh';

type Translations = {
  [key: string]: {
    en: string;
    zh: string;
  };
};

export const translations: Translations = {
  login: { en: 'Login', zh: '登录' },
  username: { en: 'Username', zh: '用户名' },
  password: { en: 'Password', zh: '密码' },
  admin: { en: 'Admin', zh: '管理员' },
  user: { en: 'User', zh: '用户' },
  test: { en: 'Test', zh: '测试' },
  history: { en: 'History', zh: '历史' },
  agent: { en: 'Agent', zh: '智能体' },
  models: { en: 'Models', zh: '模型' },
  logout: { en: 'Logout', zh: '退出登录' },
  selectModel: { en: 'Select Model', zh: '选择模型' },
  inputText: { en: 'Input Text', zh: '输入文本' },
  uploadAudio: { en: 'Upload Audio', zh: '上传音频' },
  record: { en: 'Record', zh: '录音' },
  stop: { en: 'Stop', zh: '停止' },
  execute: { en: 'Execute Test', zh: '执行测试' },
  output: { en: 'Output', zh: '输出' },
  modelName: { en: 'Model Name', zh: '模型名称' },
  modelType: { en: 'Type', zh: '类型' },
  endpoint: { en: 'Endpoint', zh: '接口地址' },
  apiKey: { en: 'API Key', zh: 'API 密钥' },
  actions: { en: 'Actions', zh: '操作' },
  addModel: { en: 'Add Model', zh: '添加模型' },
  delete: { en: 'Delete', zh: '删除' },
  timestamp: { en: 'Timestamp', zh: '时间' },
  status: { en: 'Status', zh: '状态' },
};

type I18nContextType = {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: keyof typeof translations) => string;
};

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLang] = useState<Language>('en');

  const t = (key: keyof typeof translations) => {
    return translations[key]?.[lang] || key;
  };

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export const useI18n = () => {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used within I18nProvider');
  return context;
};
