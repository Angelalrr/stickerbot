import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Crop as CropIcon,
  Film,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Scissors,
  Send,
  Smartphone,
  Type as TypeIcon,
  Users,
  Volume2,
} from 'lucide-react';
import type { AuthSessionState, SessionSnapshot } from './MultiUserPanel';
import type { SystemStatusInfo } from './OverviewSection';
import { STICKER_COLORS, computeStickerTextLayout } from '../utils/stickerPreview';

export interface WhatsAppGroupInfo {
  jid: string;
  subject: string;
  participants: number;
}

type CreatorMode = 'foto' | 'video' | 'texto';

interface CropRect {
  left: number;
  top: number;
  size: number;
}

interface StickerCreatorProps {
  auth: AuthSessionState | null;
  systemStatus: SystemStatusInfo | null;
  onSessionUpdate: (session: SessionSnapshot) => void;
  onSignOutPanel: () => void;
  onNavigate: (tab: 'panel' | 'resumen' | 'comandos' | 'instalacion') => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, '')} s`;
}

const MODE_TABS: Array<{ id: CreatorMode; label: string; icon: typeof ImageIcon }> = [
  { id: 'foto', label: 'Foto', icon: ImageIcon },
  { id: 'video', label: 'Video / GIF', icon: Film },
  { id: 'texto', label: 'Texto', icon: TypeIcon },
];

export function StickerCreator({
  auth,
  systemStatus,
  onSessionUpdate,
  onSignOutPanel,
  onNavigate,
}: StickerCreatorProps) {
  const token = auth?.token ?? null;
  const session = auth?.session ?? null;
  const isConnected = session?.status === 'connected';

  const limits = systemStatus?.limits;
  const maxImageMb = limits?.maxImageMb ?? 10;
  const maxVideoMb = limits?.maxVideoMb ?? 20;
  const maxVideoSeconds = limits?.maxVideoSeconds ?? 10;
  const maxStickerKb = limits?.maxStickerKb ?? 500;

  const [mode, setMode] = useState<CreatorMode>('foto');
  const [groups, setGroups] = useState<WhatsAppGroupInfo[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [selectedGroupJid, setSelectedGroupJid] = useState(session?.authorizedGroupJid || '');
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---------- Estado: foto con recorte cuadrado ----------
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [cropEnabled, setCropEnabled] = useState(true);
  const photoImgRef = useRef<HTMLImageElement | null>(null);
  const photoBoxRef = useRef<HTMLDivElement | null>(null);

  // ---------- Estado: video con recorte temporal ----------
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [cropFull, setCropFull] = useState(false);
  const [withSound, setWithSound] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isGif = videoFile?.type === 'image/gif';

  // ---------- Estado: sticker de texto ----------
  const [textInput, setTextInput] = useState('¡Hola mundo! 😎');
  const [textColorHex, setTextColorHex] = useState<string | undefined>(undefined);
  const textLayout = useMemo(
    () => computeStickerTextLayout(textInput, textColorHex),
    [textInput, textColorHex]
  );

  useEffect(() => {
    setSelectedGroupJid(session?.authorizedGroupJid || '');
  }, [session?.authorizedGroupJid]);

  // Limpiar object URLs al cambiar o desmontar
  useEffect(() => {
    return () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
  }, [photoUrl]);
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // Polling ligero del estado de la sesión para habilitar el envío
  useEffect(() => {
    if (!token) return;
    let active = true;
    async function poll() {
      try {
        const res = await fetch('/api/session/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          onSignOutPanel();
          return;
        }
        if (res.ok && active) {
          onSessionUpdate((await res.json()) as SessionSnapshot);
        }
      } catch {
        // Ignorar errores transitorios de red
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 8000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [token, onSignOutPanel, onSessionUpdate]);

  const fetchGroups = useCallback(async () => {
    if (!token) return;
    setGroupsLoading(true);
    setGroupsError(null);
    try {
      const res = await fetch('/api/session/groups', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        onSignOutPanel();
        return;
      }
      const data = (await res.json()) as { groups?: WhatsAppGroupInfo[]; error?: string };
      if (!res.ok) throw new Error(data?.error || 'No se pudieron cargar tus grupos.');
      setGroups(data.groups ?? []);
    } catch (err) {
      setGroupsError(err instanceof Error ? err.message : 'Error al cargar grupos.');
    } finally {
      setGroupsLoading(false);
    }
  }, [token, onSignOutPanel]);

  useEffect(() => {
    if (isConnected) void fetchGroups();
  }, [isConnected, fetchGroups]);

  async function handleGroupChange(jid: string) {
    setSelectedGroupJid(jid);
    setSuccess(null);
    setError(null);
    setWarning(null);
    if (!token || !jid) return;
    try {
      const res = await fetch('/api/session/group', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupJid: jid }),
      });
      if (res.status === 401) {
        onSignOutPanel();
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'No se pudo guardar el grupo.');
      onSessionUpdate(data as SessionSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el grupo.');
    }
  }

  // ---------- Foto ----------
  function pickPhoto(file: File | null | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Ese archivo no es una imagen (usa PNG, JPG o WebP).');
      return;
    }
    if (file.size > maxImageMb * 1024 * 1024) {
      setError(`La imagen pesa ${(file.size / (1024 * 1024)).toFixed(1)} MB y supera el límite de ${maxImageMb} MB.`);
      return;
    }
    setError(null);
    setSuccess(null);
    setPhotoFile(file);
    setCrop(null);
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoUrl(URL.createObjectURL(file));
  }

  function initCrop() {
    const box = photoBoxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const size = Math.max(48, Math.floor(Math.min(rect.width, rect.height)));
    setCrop({
      left: Math.floor((rect.width - size) / 2),
      top: Math.floor((rect.height - size) / 2),
      size,
    });
  }

  function onPhotoLoad(img: HTMLImageElement) {
    photoImgRef.current = img;
    if (cropEnabled) {
      requestAnimationFrame(initCrop);
    }
  }

  function startCropDrag(event: React.PointerEvent, dragMode: 'move' | 'resize') {
    event.preventDefault();
    const box = photoBoxRef.current;
    if (!box || !crop) return;
    const rect = box.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startCrop = { ...crop };

    function onMove(ev: PointerEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (dragMode === 'move') {
        setCrop({
          ...startCrop,
          left: clamp(startCrop.left + dx, 0, rect.width - startCrop.size),
          top: clamp(startCrop.top + dy, 0, rect.height - startCrop.size),
        });
      } else {
        const size = clamp(
          startCrop.size + Math.max(dx, dy),
          48,
          Math.min(rect.width - startCrop.left, rect.height - startCrop.top)
        );
        setCrop({ ...startCrop, size });
      }
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  async function buildImageBlob(): Promise<Blob | File> {
    if (!cropEnabled || !crop || !photoImgRef.current || !photoBoxRef.current) {
      return photoFile as File;
    }
    const img = photoImgRef.current;
    const rect = photoBoxRef.current.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo preparar el recorte de la imagen.');
    ctx.drawImage(
      img,
      crop.left * scaleX,
      crop.top * scaleY,
      crop.size * scaleX,
      crop.size * scaleY,
      0,
      0,
      512,
      512
    );
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo recortar la imagen.'))),
        'image/png'
      );
    });
  }

  // ---------- Video ----------
  function pickVideo(file: File | null | undefined) {
    if (!file) return;
    const isVideo = file.type.startsWith('video/');
    const isGifFile = file.type === 'image/gif';
    if (!isVideo && !isGifFile) {
      setError('Ese archivo no es un video ni un GIF (usa MP4, WebM o GIF).');
      return;
    }
    if (file.size > maxVideoMb * 1024 * 1024) {
      setError(`El video pesa ${(file.size / (1024 * 1024)).toFixed(1)} MB y supera el límite de ${maxVideoMb} MB.`);
      return;
    }
    setError(null);
    setSuccess(null);
    setVideoLoadError(null);
    setVideoFile(file);
    setVideoDuration(null);
    setPreviewing(false);
    setTrimStart(0);
    setTrimEnd(isGifFile ? maxVideoSeconds : 0);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(URL.createObjectURL(file));
  }

  function onVideoMeta(e: React.SyntheticEvent<HTMLVideoElement>) {
    const el = e.currentTarget;
    const duration = el.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      setVideoLoadError('No se pudo leer la duración del video. Prueba con un MP4 o WebM.');
      return;
    }
    setVideoLoadError(null);
    setVideoDuration(duration);
    setPreviewing(false);
    setTrimStart(0);
    setTrimEnd(Math.min(duration, maxVideoSeconds));
  }

  function handleTrimStartChange(value: number) {
    const next = clamp(value, 0, videoDuration ?? 0);
    setTrimStart(next);
    // Mantener la ventana dentro del máximo de WhatsApp
    setTrimEnd((current) => clamp(current, next + 0.5, Math.min(videoDuration ?? maxVideoSeconds, next + maxVideoSeconds)));
    setPreviewing(false);
  }

  function handleTrimEndChange(value: number) {
    const maxEnd = Math.min(videoDuration ?? maxVideoSeconds, trimStart + maxVideoSeconds);
    setTrimEnd(clamp(value, trimStart + 0.5, maxEnd));
    setPreviewing(false);
  }

  function previewTrim() {
    const el = videoRef.current;
    if (!el || isGif || videoDuration === null) return;
    el.currentTime = trimStart;
    setPreviewing(true);
    void el.play().catch(() => setPreviewing(false));
  }

  function onVideoTimeUpdate(e: React.SyntheticEvent<HTMLVideoElement>) {
    const el = e.currentTarget;
    if (previewing && el.currentTime >= trimEnd) {
      el.pause();
      el.currentTime = trimEnd;
      setPreviewing(false);
    }
  }

  // ---------- Envío ----------
  const selectedDuration = round2(Math.max(0, trimEnd - trimStart));
  const canSendPhoto = mode === 'foto' && photoFile !== null;
  const canSendVideo =
    mode === 'video' &&
    videoFile !== null &&
    (isGif || (videoDuration !== null && selectedDuration >= 0.5));
  const rawText = textInput.replace(/^\/stickertexto\s*/i, '').trim();
  const canSendText = mode === 'texto' && rawText.length > 0;
  const canSend = canSendPhoto || canSendVideo || canSendText;
  const videoTooLong = selectedDuration > maxVideoSeconds + 0.25;

  async function handleSend() {
    if (!auth || !token) return;
    if (!selectedGroupJid) {
      setError('Selecciona el grupo de destino antes de enviar.');
      return;
    }
    if (mode === 'video' && videoTooLong) {
      setError(`El recorte dura ${formatSeconds(selectedDuration)} y el máximo para stickers animados es ${maxVideoSeconds} s.`);
      return;
    }
    setSending(true);
    setError(null);
    setSuccess(null);
    setWarning(null);
    try {
      const form = new FormData();
      if (mode === 'foto') {
        form.append('mode', 'image');
        form.append('groupJid', selectedGroupJid);
        const blob = await buildImageBlob();
        form.append('file', blob, 'sticker.png');
      } else if (mode === 'video') {
        form.append('mode', 'video');
        form.append('groupJid', selectedGroupJid);
        form.append('file', videoFile as File);
        form.append('trimStart', String(isGif ? 0 : round2(trimStart)));
        form.append('trimDuration', String(isGif ? maxVideoSeconds : selectedDuration));
        form.append('cropMode', cropFull ? 'completo' : 'centrado');
        form.append('withSound', withSound ? 'true' : 'false');
      } else {
        form.append('mode', 'text');
        form.append('groupJid', selectedGroupJid);
        form.append('text', rawText);
        if (textColorHex) form.append('color', textColorHex);
      }

      const res = await fetch('/api/sticker/create', {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}` },
        body: form,
      });
      if (res.status === 401) {
        onSignOutPanel();
        return;
      }
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        warning?: string;
        groupJid?: string;
        duration?: number;
      };
      if (!res.ok) throw new Error(data?.error || 'No se pudo enviar el sticker.');
      const target = groups.find((g) => g.jid === (data.groupJid || selectedGroupJid));
      setSuccess(`Sticker enviado a "${target?.subject || 'tu grupo'}". ¡Revisa WhatsApp!`);
      if (data.warning) setWarning(data.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar el sticker.');
    } finally {
      setSending(false);
    }
  }

  // ---------- Pantallas de bloqueo ----------
  if (!auth || !session) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 sm:p-10 text-center max-w-xl mx-auto space-y-4">
        <Smartphone className="w-10 h-10 text-green-700 mx-auto" />
        <h2 className="font-display text-2xl font-bold text-slate-900">
          Inicia sesión para crear stickers
        </h2>
        <p className="text-sm text-slate-600 leading-relaxed">
          El creador de stickers envía directamente a tu WhatsApp. Primero registra tu usuario con
          PIN y vincula tu cuenta en el Panel.
        </p>
        <button
          type="button"
          onClick={() => onNavigate('panel')}
          className="inline-flex items-center gap-2 px-5 py-3 bg-green-700 hover:bg-green-800 text-white text-sm font-bold rounded-xl transition-colors"
        >
          <Smartphone className="w-4 h-4" />
          Ir al Panel WhatsApp
        </button>
      </div>
    );
  }

  if (!isConnected) {
    const statusHint =
      session.status === 'connecting'
        ? 'Estamos conectando con WhatsApp...'
        : session.status === 'qr_ready'
          ? 'Escanea el código QR en el Panel para vincular tu cuenta.'
          : session.status === 'pairing_ready'
            ? `Introduce el código de 8 dígitos (${session.pairingCode ?? 'pendiente'}) en WhatsApp → Dispositivos vinculados.`
            : 'Vincula tu cuenta de WhatsApp desde el Panel para habilitar el creador.';
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-8 sm:p-10 text-center max-w-xl mx-auto space-y-4">
        <AlertTriangle className="w-10 h-10 text-amber-700 mx-auto" />
        <h2 className="font-display text-2xl font-bold text-amber-950">WhatsApp no está vinculado</h2>
        <p className="text-sm text-amber-900 leading-relaxed">{statusHint}</p>
        <button
          type="button"
          onClick={() => onNavigate('panel')}
          className="inline-flex items-center gap-2 px-5 py-3 bg-amber-600 hover:bg-amber-700 text-white text-sm font-bold rounded-xl transition-colors"
        >
          <Smartphone className="w-4 h-4" />
          Abrir Panel WhatsApp
        </button>
      </div>
    );
  }

  const groupOptions = [...groups];
  if (selectedGroupJid && !groupOptions.some((g) => g.jid === selectedGroupJid)) {
    groupOptions.unshift({ jid: selectedGroupJid, subject: 'Grupo autorizado actual', participants: 0 });
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden bg-gradient-to-br from-green-950 via-green-900 to-emerald-800 rounded-2xl p-6 sm:p-8 text-white shadow-lg">
        <div className="absolute -right-8 -top-12 w-48 h-48 rounded-full bg-emerald-400/10 blur-2xl" />
        <p className="relative text-xs font-semibold tracking-[0.18em] uppercase text-emerald-200">Tu estudio creativo</p>
        <h2 className="relative font-display text-3xl sm:text-4xl font-bold mt-2">Creador de stickers</h2>
        <p className="relative text-sm sm:text-base text-emerald-50/90 mt-2 max-w-2xl">
          Elige una foto, video o texto, ajústalo a tu gusto y envíalo como sticker 512×512
          directamente a tu grupo de WhatsApp.
        </p>
        {systemStatus && !systemStatus.ffmpegAvailable && (
          <p className="relative mt-4 text-xs font-medium text-amber-950 bg-amber-100 border border-amber-200 rounded-lg px-3 py-2">
            FFmpeg no está disponible en este servidor: los stickers de video no funcionarán hasta
            desplegar el Dockerfile en Render.
          </p>
        )}
      </div>

      {/* Selector de grupo de destino */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-3 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-slate-900 font-semibold text-base">
            <Users className="w-4 h-4 text-green-700 shrink-0" />
            <h3>Grupo de destino</h3>
          </div>
          <button
            type="button"
            onClick={() => void fetchGroups()}
            disabled={groupsLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg transition-colors disabled:opacity-60"
          >
            {groupsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Actualizar
          </button>
        </div>

        {groupsError && (
          <p className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {groupsError} Puedes autorizar el grupo manualmente desde el Panel con{' '}
            <code className="font-mono">//pingdiag</code>.
          </p>
        )}

        {groups.length === 0 && !groupsError && !groupsLoading ? (
          <p className="text-xs text-slate-500">
            No se encontraron grupos. Verifica que tu cuenta esté en el grupo y pulsa "Actualizar".
            También puedes autorizarlo manualmente desde el Panel.
          </p>
        ) : (
          <select
            value={selectedGroupJid}
            onChange={(e) => void handleGroupChange(e.target.value)}
            aria-label="Grupo de WhatsApp de destino"
            className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-700"
          >
            <option value="">— Selecciona un grupo —</option>
            {groupOptions.map((group) => (
              <option key={group.jid} value={group.jid}>
                {group.subject}
                {group.participants > 0 ? ` (${group.participants} participantes)` : ''}
              </option>
            ))}
          </select>
        )}
        {selectedGroupJid && (
          <p className="text-xs text-slate-500 font-mono break-all">{selectedGroupJid}</p>
        )}
      </section>

      {/* Pestañas de modo */}
      <div className="flex flex-wrap gap-1.5 p-1 bg-slate-100 rounded-lg w-fit">
        {MODE_TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = mode === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setMode(tab.id);
                setSuccess(null);
                setWarning(null);
                setError(null);
              }}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs sm:text-sm font-semibold rounded-md transition-colors whitespace-nowrap ${
                isActive ? 'bg-white text-green-800 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Panel del modo actual */}
      <section className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 space-y-5 shadow-sm">
        {mode === 'foto' && (
          <div className="space-y-5">
            <div className="flex items-center gap-2 text-slate-900 font-semibold text-base">
              <ImageIcon className="w-4 h-4 text-green-700 shrink-0" />
              <h3>Foto a sticker</h3>
            </div>

            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pickPhoto(e.dataTransfer.files?.[0]);
              }}
              className="block border-2 border-dashed border-slate-300 hover:border-green-600 rounded-xl px-6 py-8 text-center cursor-pointer transition-colors"
            >
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={(e) => {
                  pickPhoto(e.target.files?.[0]);
                  e.currentTarget.value = '';
                }}
              />
              <ImageIcon className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-700">
                {photoFile ? photoFile.name : 'Haz clic o arrastra una imagen (PNG, JPG, WebP)'}
              </p>
              <p className="text-xs text-slate-500 mt-1">Máximo {maxImageMb} MB</p>
            </label>

            {photoUrl && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                    <CropIcon className="w-4 h-4 text-green-700" />
                    Recorte cuadrado (arrastra la caja o su esquina)
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cropEnabled}
                        onChange={(e) => {
                          setCropEnabled(e.target.checked);
                          if (e.target.checked) {
                            requestAnimationFrame(initCrop);
                          } else {
                            setCrop(null);
                          }
                        }}
                        className="accent-green-700"
                      />
                      Activar recorte
                    </label>
                    {cropEnabled && crop && (
                      <button
                        type="button"
                        onClick={() => initCrop()}
                        className="text-xs font-medium text-green-700 hover:text-green-800"
                      >
                        Restablecer
                      </button>
                    )}
                  </div>
                </div>

                <div className="checkerboard-bg border border-slate-200 rounded-xl overflow-hidden">
                  <div
                    ref={photoBoxRef}
                    className="relative w-full aspect-square sm:aspect-auto sm:max-h-[560px] overflow-hidden select-none bg-slate-100 flex items-center justify-center"
                    style={{ touchAction: 'none' }}
                  >
                    <img
                      src={photoUrl}
                      alt="Imagen seleccionada para el sticker"
                      className="block w-full h-full sm:h-auto object-contain"
                      onLoad={(e) => onPhotoLoad(e.currentTarget)}
                      draggable={false}
                    />
                    {cropEnabled && crop && (
                      <div
                        role="application"
                        aria-label="Área de recorte cuadrado"
                        onPointerDown={(e) => startCropDrag(e, 'move')}
                        className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(15,23,42,0.55)]"
                        style={{
                          left: crop.left,
                          top: crop.top,
                          width: crop.size,
                          height: crop.size,
                          touchAction: 'none',
                        }}
                      >
                        <span
                          onPointerDown={(e) => startCropDrag(e, 'resize')}
                          className="absolute -bottom-1.5 -right-1.5 w-4 h-4 bg-white border-2 border-green-700 rounded-sm cursor-nwse-resize"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {mode === 'video' && (
          <div className="space-y-5">
            <div className="flex items-center gap-2 text-slate-900 font-semibold text-base">
              <Film className="w-4 h-4 text-green-700 shrink-0" />
              <h3>Video / GIF a sticker animado</h3>
            </div>

            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                pickVideo(e.dataTransfer.files?.[0]);
              }}
              className="block border-2 border-dashed border-slate-300 hover:border-green-600 rounded-xl px-6 py-8 text-center cursor-pointer transition-colors"
            >
              <input
                type="file"
                accept="video/mp4,video/webm,video/quicktime,image/gif"
                className="sr-only"
                onChange={(e) => {
                  pickVideo(e.target.files?.[0]);
                  e.currentTarget.value = '';
                }}
              />
              <Film className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-slate-700">
                {videoFile ? videoFile.name : 'Haz clic o arrastra un video (MP4, WebM) o GIF'}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Máximo {maxVideoMb} MB · los stickers animados duran hasta {maxVideoSeconds} s
              </p>
            </label>

            {videoUrl && !isGif && (
              <div className="space-y-4">
                <video
                  ref={videoRef}
                  src={videoUrl}
                  controls
                  muted
                  playsInline
                  onLoadedMetadata={onVideoMeta}
                  onTimeUpdate={onVideoTimeUpdate}
                  className="w-full max-w-md mx-auto rounded-xl border border-slate-200 bg-black"
                />

                {videoLoadError && (
                  <p className="text-xs font-medium text-red-700">{videoLoadError}</p>
                )}

                {videoDuration !== null && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                      <Scissors className="w-4 h-4 text-green-700" />
                      Recorte del fragmento (máx. {maxVideoSeconds} s · video completo:{' '}
                      {formatSeconds(videoDuration)})
                    </div>

                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label htmlFor="trim-start" className="block text-xs font-semibold text-slate-600">
                          Inicio: {formatSeconds(trimStart)}
                        </label>
                        <input
                          id="trim-start"
                          type="range"
                          min={0}
                          max={Math.max(0, round2((videoDuration ?? 0) - 0.5))}
                          step={0.1}
                          value={trimStart}
                          onChange={(e) => handleTrimStartChange(Number(e.target.value))}
                          className="w-full accent-green-700"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="trim-end" className="block text-xs font-semibold text-slate-600">
                          Fin: {formatSeconds(trimEnd)}
                        </label>
                        <input
                          id="trim-end"
                          type="range"
                          max={round2(videoDuration ?? maxVideoSeconds)}
                          min={round2(Math.min(videoDuration ?? maxVideoSeconds, trimStart + 0.5))}
                          step={0.1}
                          value={trimEnd}
                          onChange={(e) => handleTrimEndChange(Number(e.target.value))}
                          className="w-full accent-green-700"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className={`text-xs font-semibold tabular-nums ${videoTooLong ? 'text-red-700' : 'text-slate-700'}`}>
                        Fragmento seleccionado: {formatSeconds(selectedDuration)} / máx. {maxVideoSeconds} s
                      </p>
                      <button
                        type="button"
                        onClick={previewTrim}
                        className="px-3 py-1.5 text-xs font-medium text-green-700 hover:text-green-800 border border-green-200 rounded-lg transition-colors"
                      >
                        Previsualizar fragmento
                      </button>
                    </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {videoUrl && isGif && (
              <div className="space-y-3">
                <img
                  src={videoUrl}
                  alt="GIF seleccionado para el sticker"
                  className="w-full max-w-md mx-auto rounded-xl border border-slate-200"
                />
                <p className="text-xs text-slate-600">
                  Los GIF se convierten completos: si dura más de {maxVideoSeconds} s, el servidor
                  usa los primeros {maxVideoSeconds} s.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-700">Encuadre</p>
                <div className="flex flex-col gap-1.5 text-sm">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="video-crop"
                      checked={!cropFull}
                      onChange={() => setCropFull(false)}
                      className="accent-green-700"
                    />
                    Cuadrado centrado (sin bordes)
                  </label>
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="video-crop"
                      checked={cropFull}
                      onChange={() => setCropFull(true)}
                      className="accent-green-700"
                    />
                    Completo (conserva toda la proporción)
                  </label>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-700">Sonido</p>
                <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={withSound}
                    onChange={(e) => setWithSound(e.target.checked)}
                    className="accent-green-700"
                  />
                  <span className="inline-flex items-center gap-1.5">
                    <Volume2 className="w-4 h-4 text-green-700" />
                    Sound Sticker nativo (reproducible al pulsar)
                  </span>
                </label>
                <p className="text-xs text-slate-500">
                  El video debe tener pista de audio y el fragmento recortado.
                </p>
              </div>
            </div>
          </div>
        )}

        {mode === 'texto' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-5">
              <div className="flex items-center gap-2 text-slate-900 font-semibold text-base">
                <TypeIcon className="w-4 h-4 text-green-700 shrink-0" />
                <h3>Texto a sticker</h3>
              </div>

              <div className="space-y-2">
                <label htmlFor="creator-text-input" className="block text-xs font-semibold text-slate-700">
                  Texto del sticker
                </label>
                <textarea
                  id="creator-text-input"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Escribe tu mensaje... (puedes iniciar con un color: rojo ¡Hola!)"
                  rows={3}
                  maxLength={120}
                  className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-700 resize-none"
                />
                <p className="text-xs text-slate-500">
                  Truco: inicia con un color como <code className="font-mono">rojo</code>,{' '}
                  <code className="font-mono">azul</code> o un hex <code className="font-mono">#FF0000</code>.
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-700">Color (opcional)</p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setTextColorHex(undefined)}
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                      textColorHex === undefined
                        ? 'border-green-700 bg-green-50 text-green-900'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    Automático
                  </button>
                  {STICKER_COLORS.map((color) => {
                    const active = textColorHex?.toUpperCase() === color.hex.toUpperCase();
                    return (
                      <button
                        key={color.name}
                        type="button"
                        onClick={() => setTextColorHex(color.hex)}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                          active
                            ? 'border-green-700 bg-green-50 text-green-900'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <span
                          className="w-3 h-3 rounded-sm border border-slate-300 shrink-0"
                          style={{ backgroundColor: color.hex }}
                        />
                        {color.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-slate-700">Vista previa 512×512</p>
              <div className="checkerboard-bg border border-slate-200 rounded-xl p-4 flex items-center justify-center">
                <svg
                  viewBox="0 0 512 512"
                  className="w-56 h-56 sm:w-64 sm:h-64"
                  role="img"
                  aria-label={`Vista previa del sticker con el texto ${textLayout.text}`}
                >
                  <defs>
                    <filter id="creatorStickerShadow" x="-20%" y="-20%" width="140%" height="140%">
                      <feDropShadow dx="0" dy="5" stdDeviation="4" floodColor="#000000" floodOpacity="0.5" />
                    </filter>
                  </defs>
                  {textLayout.lines.map((line, index) => (
                    <text
                      key={`${index}-${line}`}
                      x="256"
                      y={textLayout.firstBaselineY + index * textLayout.lineHeight}
                      textAnchor="middle"
                      fontFamily="Plus Jakarta Sans, Segoe UI Emoji, Noto Color Emoji, sans-serif"
                      fontWeight="800"
                      fontSize={textLayout.fontSize}
                      fill={textLayout.fillColor}
                      stroke={textLayout.strokeColor}
                      strokeWidth={textLayout.strokeWidth}
                      strokeLinejoin="round"
                      paintOrder="stroke fill"
                      filter="url(#creatorStickerShadow)"
                    >
                      {line}
                    </text>
                  ))}
                </svg>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Envío */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 sm:p-6 space-y-4 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              {mode === 'foto'
                ? 'Sticker de foto'
                : mode === 'video'
                  ? 'Sticker animado'
                  : 'Sticker de texto'}
              {' '}· 512×512 · máx. {maxStickerKb} KB
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              {mode === 'video'
                ? 'La conversión la hace el servidor con FFmpeg (puede tardar unos segundos).'
                : 'Se procesa en el servidor y se envía al grupo seleccionado.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!canSend || sending || !selectedGroupJid || (mode === 'video' && videoTooLong)}
            className="inline-flex items-center justify-center gap-2 px-6 py-3.5 bg-green-700 hover:bg-green-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm sm:text-base font-bold rounded-xl shadow-sm transition-colors whitespace-nowrap"
          >
            {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-4 h-4 sm:w-5 sm:h-5" />}
            {sending ? 'Procesando y enviando...' : selectedGroupJid ? `Enviar a ${groups.find((group) => group.jid === selectedGroupJid)?.subject || 'WhatsApp'}` : 'Enviar a WhatsApp'}
          </button>
        </div>

        {success && (
          <p role="status" className="flex items-start gap-2 text-sm font-medium text-green-800 bg-green-50 border border-green-200 rounded-lg px-4 py-3">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            {success}
          </p>
        )}
        {warning && (
          <p className="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5">
            {warning}
          </p>
        )}
        {error && (
          <p role="alert" className="flex items-start gap-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
