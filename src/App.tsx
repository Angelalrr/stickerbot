import { useCallback, useEffect, useState } from 'react';
import { OverviewSection, type SystemStatusInfo } from './components/OverviewSection';
import {
  MultiUserPanel,
  type AuthSessionState,
  type SessionSnapshot,
} from './components/MultiUserPanel';
import { StickerCreator } from './components/StickerCreator';
import { CommandWorkbench } from './components/CommandWorkbench';
import { InstallGuide } from './components/InstallGuide';

export type ActiveTab = 'resumen' | 'creador' | 'panel' | 'comandos' | 'instalacion';

const NAV_ITEMS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'resumen', label: 'Resumen' },
  { id: 'creador', label: 'Creador' },
  { id: 'panel', label: 'Panel' },
  { id: 'comandos', label: 'Comandos' },
  { id: 'instalacion', label: 'Render' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('resumen');
  const [systemStatus, setSystemStatus] = useState<SystemStatusInfo | null>(null);
  const [auth, setAuth] = useState<AuthSessionState | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/system/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SystemStatusInfo | null) => {
        if (active && data) setSystemStatus(data);
      })
      .catch(() => {
        // Ignorar si falla en arranque
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSessionUpdate = useCallback((session: SessionSnapshot) => {
    setAuth((prev) => (prev ? { ...prev, session } : null));
  }, []);

  const handleSignOutPanel = useCallback(() => {
    setAuth(null);
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3 sm:gap-8">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('resumen');
            }}
            className="font-display text-lg font-extrabold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            StickerBot
          </a>

          <nav aria-label="Navegación principal" className="flex items-center gap-3 sm:gap-6">
            {NAV_ITEMS.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`text-xs sm:text-sm font-medium py-1 whitespace-nowrap shrink-0 border-b-2 transition-colors ${
                    isActive
                      ? 'text-green-800 border-green-700'
                      : 'text-slate-600 border-transparent hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-10">
        {activeTab === 'resumen' && (
          <OverviewSection
            systemStatus={systemStatus}
            onNavigate={(tab) => setActiveTab(tab)}
          />
        )}
        {activeTab === 'creador' && (
          <StickerCreator
            auth={auth}
            systemStatus={systemStatus}
            onSessionUpdate={handleSessionUpdate}
            onSignOutPanel={handleSignOutPanel}
            onNavigate={(tab) => setActiveTab(tab)}
          />
        )}
        {activeTab === 'panel' && (
          <MultiUserPanel
            auth={auth}
            dbMode={systemStatus?.dbMode || 'local'}
            onAuthenticated={setAuth}
            onSessionUpdate={handleSessionUpdate}
            onSignOutPanel={handleSignOutPanel}
          />
        )}
        {activeTab === 'comandos' && <CommandWorkbench />}
        {activeTab === 'instalacion' && <InstallGuide />}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
          <span>StickerBot · Bot multi-usuario de WhatsApp listo para Render Docker Free</span>
          <span>Usa /health cada 10–14 min en cron-job.org para mantener el servicio activo</span>
        </div>
      </footer>
    </div>
  );
}
