import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, RotateCcw } from 'lucide-react';
import { INSTALL_STEPS } from '../data/guideSteps';

const STORAGE_KEY = 'stickerbot_render_steps_v2';

export function InstallGuide() {
  const [completedIds, setCompletedIds] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Ignorar errores de almacenamiento
    }
    return [];
  });

  const [copiedId, setCopiedId] = useState<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(completedIds));
    } catch {
      // Ignorar errores de almacenamiento
    }
  }, [completedIds]);

  function toggleStep(id: number) {
    setCompletedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  async function copyCommand(id: number, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 1800);
    } catch {
      // Fallback silencioso
    }
  }

  const completedCount = completedIds.length;

  return (
    <div className="space-y-8">
      <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold text-slate-900">
            Guía paso a paso para desplegar gratis en Render (Docker)
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Marca cada paso conforme lo completes. Tu progreso se guarda automáticamente en este navegador.
          </p>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <div className="text-right">
            <p className="text-xs text-slate-500">Progreso</p>
            <p className="font-mono text-lg font-bold text-slate-900 tabular-nums">
              {completedCount} / {INSTALL_STEPS.length} completados
            </p>
          </div>
          {completedCount > 0 && (
            <button
              type="button"
              onClick={() => setCompletedIds([])}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reiniciar
            </button>
          )}
        </div>
      </div>

      <div className="space-y-4">
        {INSTALL_STEPS.map((step) => {
          const isDone = completedIds.includes(step.id);

          return (
            <article
              key={step.id}
              className={`bg-white border rounded-xl p-6 transition-colors ${
                isDone ? 'border-green-300 bg-green-50/20' : 'border-slate-200'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4 w-full">
                  <button
                    type="button"
                    onClick={() => toggleStep(step.id)}
                    aria-label={`Marcar paso ${step.id}: ${step.title}`}
                    aria-pressed={isDone}
                    className={`mt-0.5 w-7 h-7 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                      isDone
                        ? 'bg-green-700 border-green-700 text-white'
                        : 'bg-white border-slate-300 text-slate-500 hover:border-slate-400'
                    }`}
                  >
                    {isDone ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <span className="font-mono text-xs font-semibold tabular-nums">{step.id}</span>
                    )}
                  </button>

                  <div className="space-y-3 flex-1 min-w-0">
                    <h3
                      className={`font-display text-lg font-bold ${
                        isDone ? 'text-green-900' : 'text-slate-900'
                      }`}
                    >
                      {String(step.id).padStart(2, '0')}. {step.title}
                    </h3>

                    {step.conceptNote && (
                      <p className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
                        <strong className="font-semibold text-slate-900">
                          {step.conceptNote.term}:{' '}
                        </strong>
                        {step.conceptNote.explanation}
                      </p>
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm">
                      <div className="space-y-1.5">
                        <p className="text-xs font-semibold text-slate-500">
                          Dónde hacer clic y qué hacer
                        </p>
                        <p className="text-slate-700 whitespace-pre-line leading-relaxed">
                          {step.whereToClick}
                        </p>
                        {step.link && (
                          <a
                            href={step.link.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-700 hover:text-green-800 pt-1"
                          >
                            {step.link.label}
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>

                      <div className="space-y-2.5">
                        <p className="text-xs font-semibold text-slate-500">
                          Referencia: <span className="font-normal text-slate-700">{step.terminalName}</span>
                        </p>

                        {step.command && (
                          <div className="flex items-center justify-between gap-2 bg-slate-900 text-emerald-300 rounded-lg px-3.5 py-2.5">
                            <code className="font-mono text-xs sm:text-sm overflow-x-auto">
                              {step.command}
                            </code>
                            <button
                              type="button"
                              onClick={() => copyCommand(step.id, step.command!)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0"
                            >
                              {copiedId === step.id ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                  Copiado
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5" />
                                  Copiar
                                </>
                              )}
                            </button>
                          </div>
                        )}

                        <div className="text-xs text-slate-600 space-y-1 leading-relaxed">
                          <p>
                            <strong className="text-slate-800">Qué debe aparecer:</strong>{' '}
                            {step.expectedOutput}
                          </p>
                          <p>
                            <strong className="text-slate-800">Cómo saber si salió bien:</strong>{' '}
                            {step.howToVerify}
                          </p>
                          <p>
                            <strong className="text-slate-800">Si sale un error:</strong>{' '}
                            {step.ifError}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
