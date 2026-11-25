import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Check,
  KeyRound,
  LogOut,
  Phone,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Unplug,
  UserCheck,
} from 'lucide-react';

export interface SessionSnapshot {
  userId: string;
  status:
    | 'disconnected'
    | 'connecting'
    | 'qr_ready'
    | 'pairing_ready'
    | 'connected'
    | 'logged_out'
    | 'error';
  qrDataUrl: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  connectedAccountName: string | null;
  connectedJid: string | null;
  authorizedGroupJid: string;
  lastDetectedGroupJid: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface AuthSessionState {
  token: string;
  userId: string;
  session: SessionSnapshot;
}

interface MultiUserPanelProps {
  auth: AuthSessionState | null;
  dbMode: 'mongodb' | 'local';
  onAuthenticated: (auth: AuthSessionState) => void;
  onSessionUpdate: (session: SessionSnapshot) => void;
  onSignOutPanel: () => void;
}

const STATUS_LABELS: Record<SessionSnapshot['status'], string> = {
  disconnected: 'Desconectado',
  connecting: 'Iniciando conexión con WhatsApp...',
  qr_ready: 'Código QR listo para escanear',
  pairing_ready: 'Código de 8 dígitos listo',
  connected: 'WhatsApp conectado y activo',
  logged_out: 'Sesión cerrada desde WhatsApp',
  error: 'Error de conexión',
};

export function MultiUserPanel({
  auth,
  dbMode,
  onAuthenticated,
  onSessionUpdate,
  onSignOutPanel,
}: MultiUserPanelProps) {
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [userIdInput, setUserIdInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [phoneInput, setPhoneInput] = useState('');
  const [groupInput, setGroupInput] = useState(auth?.session.authorizedGroupJid || '');
  const [actionLoading, setActionLoading] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelSuccess, setPanelSuccess] = useState<string | null>(null);
  const [copiedPairing, setCopiedPairing] = useState(false);

  useEffect(() => {
    if (auth?.session.authorizedGroupJid !== undefined) {
      setGroupInput(auth.session.authorizedGroupJid);
    }
  }, [auth?.session.authorizedGroupJid]);

  useEffect(() => {
    if (!auth?.token) return;
    let active = true;

    async function fetchStatus() {
      if (!auth) return;
      try {
        const res = await fetch('/api/session/status', {
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        if (res.status === 401) {
          onSignOutPanel();
          return;
        }
        if (res.ok && active) {
          const data = (await res.json()) as SessionSnapshot;
          onSessionUpdate(data);
        }
      } catch {
        // Ignorar errores transitorios de red en polling
      }
    }

    const shouldFastPoll =
      auth.session.status === 'connecting' ||
      auth.session.status === 'qr_ready' ||
      auth.session.status === 'pairing_ready' ||
      auth.session.status === 'connected';

    const intervalMs = shouldFastPoll ? 2500 : 8000;
    const timer = setInterval(() => {
      void fetchStatus();
    }, intervalMs);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [auth?.token, auth?.session.status, onSessionUpdate, onSignOutPanel]);

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAuthError(null);
    setAuthLoading(true);

    try {
      const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: userIdInput.trim(),
          pin: pinInput,
        }),
      });
      const data = (await res.json()) as {
        token?: string;
        user?: { userId: string };
        session?: SessionSnapshot;
        error?: string;
      };
      if (!res.ok || !data.token || !data.user || !data.session) {
        setAuthError(data.error || 'No se pudo autenticar.');
        return;
      }
      setPinInput('');
      onAuthenticated({
        token: data.token,
        userId: data.user.userId,
        session: data.session,
      });
    } catch {
      setAuthError('No se pudo conectar con el servidor.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function callProtectedEndpoint(
    url: string,
    method: 'POST' | 'PUT' | 'GET',
    body?: Record<string, unknown>,
    successMsg?: string
  ) {
    if (!auth) return;
    setPanelError(null);
    setPanelSuccess(null);
    setActionLoading(true);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${auth.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json()) as SessionSnapshot & { error?: string };
      if (res.status === 401) {
        onSignOutPanel();
        return;
      }
      if (!res.ok) {
        setPanelError(data.error || 'Ocurrió un error al procesar la solicitud.');
        return;
      }
      onSessionUpdate(data);
      if (successMsg) setPanelSuccess(successMsg);
    } catch {
      setPanelError('Error de red al comunicarse con el servidor.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCopyPairingCode() {
    if (!auth?.session.pairingCode) return;
    try {
      await navigator.clipboard.writeText(auth.session.pairingCode);
      setCopiedPairing(true);
      setTimeout(() => setCopiedPairing(false), 1800);
    } catch {
      // Ignorar si no hay permiso
    }
  }

  if (!auth) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
          <div className="space-y-1.5">
            <h2 className="font-display text-2xl font-bold text-slate-900">
              Acceso al panel multi-usuario
            </h2>
            <p className="text-sm text-slate-600">
              Cada usuario tiene su propia sesión aislada de WhatsApp y su propio grupo autorizado.
            </p>
          </div>

          <div className="inline-flex p-1 bg-slate-100 rounded-lg" role="tablist" aria-label="Tipo de acceso">
            <button
              type="button"
              role="tab"
              aria-selected={authMode === 'register'}
              onClick={() => {
                setAuthMode('register');
                setAuthError(null);
              }}
              className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                authMode === 'register'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Crear usuario nuevo
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={authMode === 'login'}
              onClick={() => {
                setAuthMode('login');
                setAuthError(null);
              }}
              className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                authMode === 'login'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Ya tengo usuario
            </button>
          </div>

          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="panel-user-id" className="block text-xs font-semibold text-slate-700">
                Nombre de usuario (3 a 32 caracteres)
              </label>
              <input
                id="panel-user-id"
                type="text"
                autoComplete="username"
                value={userIdInput}
                onChange={(e) => setUserIdInput(e.target.value)}
                placeholder="ej. victor_bot"
                className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-700"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="panel-pin" className="block text-xs font-semibold text-slate-700">
                PIN o clave personal (mínimo 4 caracteres)
              </label>
              <input
                id="panel-pin"
                type="password"
                autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder="••••"
                className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-700"
              />
            </div>

            {authError && (
              <div
                role="alert"
                className="text-xs font-medium text-red-800 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5"
              >
                {authError}
              </div>
            )}

            <button
              type="submit"
              disabled={authLoading}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-green-700 hover:bg-green-800 disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              <KeyRound className="w-4 h-4" />
              {authLoading
                ? 'Validando...'
                : authMode === 'register'
                ? 'Crear cuenta y abrir panel'
                : 'Entrar a mi panel'}
            </button>
          </form>
        </section>

        <section className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-4">
          <h3 className="font-display text-lg font-bold text-slate-900">
            Cómo funciona el modo multi-usuario
          </h3>
          <ol className="space-y-3 text-sm text-slate-700 list-decimal list-inside leading-relaxed">
            <li>
              Crea tu usuario y PIN privado. La clave se guarda cifrada con <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">scrypt</code> y el token permanece únicamente en la memoria de esta pestaña.
            </li>
            <li>
              Vincula tu WhatsApp usando <strong>Código QR</strong> o <strong>Código de 8 dígitos</strong> (ideal si estás desde el celular sin otra pantalla).
            </li>
            <li>
              Envía <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">//pingdiag</code> dentro de tu grupo de WhatsApp para detectar su ID automáticamente y guardarlo aquí.
            </li>
            <li>
              Tu sesión y grupo se almacenan en <strong>{dbMode === 'mongodb' ? 'MongoDB Atlas' : 'almacenamiento local (data/)'}</strong> para reconectarse automáticamente.
            </li>
          </ol>
        </section>
      </div>
    );
  }

  const { session } = auth;

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-slate-900 font-semibold">
            <UserCheck className="w-4 h-4 text-green-700" />
            <span>Usuario: {auth.userId}</span>
            <span className="text-slate-300" aria-hidden="true">·</span>
            <span className="text-xs font-normal text-slate-500">
              Persistencia: {dbMode === 'mongodb' ? 'MongoDB Atlas' : 'Local temporal'}
            </span>
          </div>
          <p className="text-xs text-slate-600">
            Estado actual: <strong className="text-slate-900">{STATUS_LABELS[session.status]}</strong>
            {session.connectedAccountName ? ` (${session.connectedAccountName})` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={actionLoading}
            onClick={() => void callProtectedEndpoint('/api/session/status', 'GET')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg transition-colors whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Actualizar estado
          </button>
          <button
            type="button"
            onClick={onSignOutPanel}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-200 hover:bg-slate-50 text-slate-700 rounded-lg transition-colors whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            Salir del panel
          </button>
        </div>
      </div>

      {panelError && (
        <div
          role="alert"
          className="text-sm font-medium text-red-800 bg-red-50 border border-red-200 rounded-xl px-4 py-3"
        >
          {panelError}
        </div>
      )}

      {panelSuccess && (
        <div
          role="status"
          className="text-sm font-medium text-green-900 bg-green-50 border border-green-200 rounded-xl px-4 py-3 flex items-center gap-2"
        >
          <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0" />
          <span>{panelSuccess}</span>
        </div>
      )}

      {session.lastError && (
        <div className="text-xs font-medium text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          Aviso de conexión: {session.lastError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          <div>
            <h2 className="font-display text-xl font-bold text-slate-900">
              1. Vincular tu cuenta de WhatsApp
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              Elige escanear código QR o generar un código numérico de 8 dígitos para vincular en Dispositivos vinculados.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-slate-50 rounded-lg p-4 flex flex-col justify-between gap-3">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <QrCode className="w-4 h-4 text-green-700" />
                  <span>Opción A: Código QR</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Escanea desde WhatsApp → Dispositivos vinculados → Vincular un dispositivo.
                </p>
              </div>
              <button
                type="button"
                disabled={actionLoading}
                onClick={() =>
                  void callProtectedEndpoint(
                    '/api/session/connect-qr',
                    'POST',
                    undefined,
                    'Solicitando código QR a WhatsApp...'
                  )
                }
                className="w-full inline-flex items-center justify-center gap-2 px-3.5 py-2 bg-green-700 hover:bg-green-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg transition-colors"
              >
                <QrCode className="w-3.5 h-3.5" />
                Generar código QR
              </button>
            </div>

            <div className="bg-slate-50 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Phone className="w-4 h-4 text-green-700" />
                <span>Opción B: Código de 8 dígitos</span>
              </div>
              <label htmlFor="pairing-phone" className="block text-xs text-slate-600">
                Número con código de país (sin + ni espacios)
              </label>
              <input
                id="pairing-phone"
                type="tel"
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value)}
                placeholder="51999888777"
                className="w-full px-3 py-2 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-700"
              />
              <button
                type="button"
                disabled={actionLoading}
                onClick={() => {
                  const digits = phoneInput.replace(/\D/g, '');
                  if (digits.length < 8 || digits.length > 15) {
                    setPanelSuccess(null);
                    setPanelError(
                      'Ingresa tu número completo con código de país (ej. 51999888777, entre 8 y 15 dígitos).'
                    );
                    return;
                  }
                  void callProtectedEndpoint(
                    '/api/session/connect-pairing',
                    'POST',
                    { phoneNumber: digits },
                    'Solicitando código de 8 dígitos a WhatsApp...'
                  );
                }}
                className="w-full inline-flex items-center justify-center gap-2 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-semibold rounded-lg transition-colors"
              >
                Obtener código de 8 dígitos
              </button>
            </div>
          </div>

          {session.qrDataUrl && (
            <div className="border border-slate-200 rounded-lg p-5 bg-slate-50 flex flex-col items-center gap-3">
              <img
                src={session.qrDataUrl}
                alt="Código QR para vincular WhatsApp"
                className="w-60 h-60 bg-white p-2 rounded-lg border border-slate-200"
              />
              <p className="text-xs text-slate-600 text-center">
                Escanea este QR desde tu teléfono. Se actualiza automáticamente si caduca.
              </p>
            </div>
          )}

          {session.pairingCode && (
            <div className="border border-green-200 bg-green-50 rounded-lg p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-green-900">
                  Tu código de emparejamiento de 8 dígitos
                </p>
                <p className="font-mono text-2xl font-bold tracking-widest text-slate-900 tabular-nums mt-1">
                  {session.pairingCode}
                </p>
                <p className="text-xs text-green-800 mt-1">
                  En WhatsApp ve a Dispositivos vinculados → Vincular con número de teléfono.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleCopyPairingCode()}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-green-300 text-green-900 text-xs font-semibold rounded-lg hover:bg-green-100 transition-colors whitespace-nowrap shrink-0"
              >
                {copiedPairing ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedPairing ? 'Copiado' : 'Copiar código'}
              </button>
            </div>
          )}

          {session.status === 'connected' && (
            <div className="border border-green-200 bg-green-50 rounded-lg p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-2.5 text-sm text-green-900 font-medium">
                <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0" />
                <span>WhatsApp conectado ({session.connectedAccountName || 'Listo'})</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() =>
                    void callProtectedEndpoint(
                      '/api/session/disconnect',
                      'POST',
                      undefined,
                      'Socket desconectado (credenciales conservadas).'
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-300 text-slate-700 text-xs font-medium rounded-lg hover:bg-slate-50 whitespace-nowrap"
                >
                  <Unplug className="w-3.5 h-3.5" />
                  Pausar
                </button>
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() =>
                    void callProtectedEndpoint(
                      '/api/session/logout',
                      'POST',
                      undefined,
                      'Sesión de WhatsApp cerrada y credenciales eliminadas.'
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg whitespace-nowrap"
                >
                  Desvincular
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-green-700 shrink-0" />
            <h2 className="font-display text-xl font-bold text-slate-900">
              2. Grupo autorizado
            </h2>
          </div>

          <p className="text-sm text-slate-600 leading-relaxed">
            Para evitar que el bot responda en otros chats, solo responderá en el grupo que guardes aquí. Escribe{' '}
            <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded font-semibold">
              //pingdiag
            </code>{' '}
            en tu grupo de WhatsApp para ver su ID.
          </p>

          {session.lastDetectedGroupJid && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-2">
              <p className="text-xs font-semibold text-slate-700">
                Último grupo detectado con //pingdiag:
              </p>
              <p className="font-mono text-xs text-slate-900 break-all">
                {session.lastDetectedGroupJid}
              </p>
              <button
                type="button"
                onClick={() => {
                  const detected = session.lastDetectedGroupJid!;
                  setGroupInput(detected);
                  void callProtectedEndpoint(
                    '/api/session/group',
                    'PUT',
                    { groupJid: detected },
                    'Grupo autorizado guardado correctamente.'
                  );
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-700 hover:bg-green-800 text-white text-xs font-semibold rounded-md transition-colors"
              >
                Usar este grupo
              </button>
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="authorized-group-jid" className="block text-xs font-semibold text-slate-700">
              ID del grupo (@g.us)
            </label>
            <input
              id="authorized-group-jid"
              type="text"
              value={groupInput}
              onChange={(e) => setGroupInput(e.target.value)}
              placeholder="120363012345678901@g.us"
              className="w-full px-3.5 py-2.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-700"
            />
          </div>

          <button
            type="button"
            disabled={actionLoading}
            onClick={() =>
              void callProtectedEndpoint(
                '/api/session/group',
                'PUT',
                { groupJid: groupInput },
                'Grupo autorizado actualizado.'
              )
            }
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Guardar grupo autorizado
          </button>

          <p className="text-xs text-slate-500 font-mono break-all">
            Activo actualmente: {session.authorizedGroupJid || 'Ninguno configurado'}
          </p>
        </section>
      </div>
    </div>
  );
}
