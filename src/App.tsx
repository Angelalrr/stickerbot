import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { OverviewSection, type SystemStatusInfo } from './components/OverviewSection';
import {
  MultiUserPanel,
  type AuthSessionState,
  type SessionSnapshot,
} from './components/MultiUserPanel';
import { CommandWorkbench } from './components/CommandWorkbench';
import { InstallGuide } from './components/InstallGuide';
import { downloadRenderZip } from './utils/renderExport';

type ActiveTab = 'resumen' | 'panel' | 'comandos' | 'instalacion';

const NAV_ITEMS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'resumen', label: 'Resumen' },
  { id: 'panel', label: 'Panel' },
  { id: 'comandos', label: 'Comandos' },
  { id: 'instalacion', label: 'Render' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('resumen');
  const [systemStatus, setSystemStatus] = useState<SystemStatusInfo | null>(null);
  const [auth, setAuth] = useState<AuthSessionState | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

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

  const handleDownloadRender = useCallback(async () => {
    setDownloadError(null);
    setDownloading(true);
    try {
      await downloadRenderZip();
    } catch (err) {
      setDownloadError(
        err instanceof Error ? err.message : 'No se pudo descargar StickerBot-Render.zip.'
      );
    } finally {
      setDownloading(false);
    }
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

          <nav aria-label="Navegación principal" className="flex items-center gap-3.5 sm:gap-7">
            {NAV_ITEMS.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`text-xs sm:text-sm font-medium py-1 whitespace-nowrap shrink-0 border-b-2 ${
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

          <div className="hidden sm:flex items-center shrink-0">
            <button
              type="button"
              onClick={() => void handleDownloadRender()}
              disabled={downloading}
              className="inline-flex items-center gap-2 px-4 py-2 bg-green-700 hover:bg-green-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              {downloading ? 'Generando...' : 'Descargar para Render'}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-10">
        {activeTab === 'resumen' && (
          <OverviewSection
            systemStatus={systemStatus}
            downloading={downloading}
            downloadError={downloadError}
            onNavigate={(tab) => setActiveTab(tab)}
            onDownloadRender={() => void handleDownloadRender()}
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
