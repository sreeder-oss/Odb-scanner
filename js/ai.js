// Client-side BYOK AI Assistant module for BayScope OBD-II.
// Supports Anthropic (Claude), Google (Gemini), and OpenRouter (DeepSeek) direct from the browser via SSE streaming.
// Never hardcodes or logs API keys.

import { computeBaselineComparison, extractMarkedMomentWindows } from './export.js';

export const AI_PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-sonnet-5-5',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Google (Gemini)',
    defaultModel: 'gemini-4-flash',
    models: [
      { id: 'gemini-4-flash', label: 'Gemini 4 Flash' },
      { id: 'gemini-4-pro', label: 'Gemini 4 Pro' },
    ],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (DeepSeek)',
    defaultModel: 'deepseek/deepseek-v4.1-flash',
    models: [
      { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash (1017)' },
    ],
  },
};

export const SYSTEM_PROMPT_BASE =
  "You are BayScope's diagnostic assistant. You receive OBD-II session context from a web app talking to an ELM327 adapter. Use only the data provided. Be explicit about uncertainty: OBD data points toward causes but does not prove them, and short drives can miss intermittent faults. Never dismiss CVT judder or shudder symptoms as 'no action needed' merely because zero DTCs are stored — evaluate RPM/speed stability, STFT oscillations, timing stability, and fluid service history (genuine NS-3 spec, temperature-controlled level check, TCM adaptation reset). When a savedVehicleBaseline is present, explicitly compare current metrics against the baseline. When the user is evaluating a used car, focus on risk, inspection items, seller questions, negotiation points, and walk-away triggers. When the user is troubleshooting their own vehicle, rank likely causes with the data that supports or argues against each, give next diagnostic steps cheapest and most informative first, and say whether it looks safe to keep driving. Be concise and avoid repeating the whole context back. Never invent PID values that were not provided.";

const KEY_PROVIDER = 'bayscope_ai_provider_v1';
const KEY_MODEL = 'bayscope_ai_model_v1';
const KEY_ANTHROPIC = 'bayscope_ai_key_anthropic_v1';
const KEY_GEMINI = 'bayscope_ai_key_gemini_v1';
const KEY_OPENROUTER = 'bayscope_ai_key_openrouter_v1';
const KEY_PRIVACY_ACK = 'bayscope_ai_privacy_ack_v1';

function getKeyStorageSlot(provider) {
  if (provider === 'gemini') return KEY_GEMINI;
  if (provider === 'openrouter') return KEY_OPENROUTER;
  return KEY_ANTHROPIC;
}

export function loadAiConfig() {
  const providerRaw = localStorage.getItem(KEY_PROVIDER);
  const provider = providerRaw && AI_PROVIDERS[providerRaw] ? providerRaw : 'anthropic';
  const provMeta = AI_PROVIDERS[provider];
  const savedModel = localStorage.getItem(KEY_MODEL);
  const model = provMeta.models.some((m) => m.id === savedModel) ? savedModel : provMeta.defaultModel;

  return {
    provider,
    model,
    keys: {
      anthropic: localStorage.getItem(KEY_ANTHROPIC) || '',
      gemini: localStorage.getItem(KEY_GEMINI) || '',
      openrouter: localStorage.getItem(KEY_OPENROUTER) || '',
    },
    privacyAck: localStorage.getItem(KEY_PRIVACY_ACK) === '1',
  };
}

export function saveAiProviderAndModel(provider, model) {
  const validProvider = AI_PROVIDERS[provider] ? provider : 'anthropic';
  const provMeta = AI_PROVIDERS[validProvider];
  const validModel = provMeta.models.some((m) => m.id === model) ? model : provMeta.defaultModel;
  localStorage.setItem(KEY_PROVIDER, validProvider);
  localStorage.setItem(KEY_MODEL, validModel);
  return { provider: validProvider, model: validModel };
}

export function saveAiKey(provider, keyStr) {
  const trimmed = String(keyStr || '').trim();
  const storageKey = getKeyStorageSlot(provider);
  if (trimmed) {
    localStorage.setItem(storageKey, trimmed);
  } else {
    localStorage.removeItem(storageKey);
  }
}

export function clearAiKey(provider) {
  localStorage.removeItem(getKeyStorageSlot(provider));
}

export function setPrivacyAck() {
  localStorage.setItem(KEY_PRIVACY_ACK, '1');
}

export function clearAllAiStorage() {
  localStorage.removeItem(KEY_PROVIDER);
  localStorage.removeItem(KEY_MODEL);
  localStorage.removeItem(KEY_ANTHROPIC);
  localStorage.removeItem(KEY_GEMINI);
  localStorage.removeItem(KEY_OPENROUTER);
  localStorage.removeItem(KEY_PRIVACY_ACK);
}

export function getModelDisplayName(provider, modelId) {
  const p = AI_PROVIDERS[provider] || AI_PROVIDERS.anthropic;
  const m = p.models.find((x) => x.id === modelId);
  return m ? m.label : modelId;
}

export function getProviderDisplayName(provider) {
  if (provider === 'gemini') return 'Google';
  if (provider === 'openrouter') return 'OpenRouter';
  return 'Anthropic';
}

// Build compact diagnostic context object for the system prompt
export function buildSessionContextObject({
  profile,
  mfrName,
  engineName,
  vehicleInfo,
  activeProfile = null,
  adapterInfo = null,
  pidHealthTracker = null,
  recordedPidIds = null,
  baseline = null,
  sessionPurpose,
  userNotes,
  dashboardPids,
  liveValues,
  pidMap,
  records,
  stats,
  isSimulated,
}) {
  const t0 = records.length > 0 ? records[0].ts : Date.now();
  const durationS = records.length > 1
    ? Number(((records[records.length - 1].ts - records[0].ts) / 1000).toFixed(1))
    : 0;

  const monitorsNotReady = (vehicleInfo.monitors || [])
    .filter((m) => !m.ready)
    .map((m) => m.name);

  const mapDtcs = (codes, descMap) =>
    (codes || []).map((code) => ({
      code,
      description: descMap[code] || 'Standard OBD-II code',
    }));

  const activeDashboard = dashboardPids
    .map((id) => {
      const meta = pidMap.get(id);
      if (!meta) return null;
      const val = liveValues[id];
      return {
        pidHex: id,
        name: meta.name,
        latestValue: val !== null && val !== undefined && Number.isFinite(val) ? Number(val.toFixed(meta.decimals)) : null,
        unit: meta.unit,
      };
    })
    .filter(Boolean);

  const sessionStats = (stats || []).map((s) => ({
    pidHex: s.pidHex,
    name: s.name,
    unit: s.unit,
    start: s.first !== null && s.first !== undefined ? Number(s.first.toFixed(s.decimals)) : null,
    end: s.last !== null && s.last !== undefined ? Number(s.last.toFixed(s.decimals)) : null,
    min: Number(s.min.toFixed(s.decimals)),
    avg: Number(s.avg.toFixed(s.decimals)),
    max: Number(s.max.toFixed(s.decimals)),
    samples: s.count,
  }));

  const pidsForWindows = Array.isArray(recordedPidIds) && recordedPidIds.length > 0
    ? recordedPidIds
    : dashboardPids;
  const markedMomentWindows = extractMarkedMomentWindows(records, pidsForWindows, pidMap, {
    windowBeforeSec: 8,
    windowAfterSec: 8,
    maxRowsPerWindow: 30,
  }).map((w) => ({
    marker: w.marker,
    atSec: w.atSec,
    window: w.window,
    csv: w.csvBlock,
  }));

  const markedMoments = records
    .filter((r) => r.event && r.event.trim())
    .map((r) => ({
      elapsed_s: Number(((r.ts - t0) / 1000).toFixed(1)),
      label: r.event.trim(),
    }));

  const hasAnyDtcs = Boolean(
    (vehicleInfo.dtcs?.stored?.length || 0) +
      (vehicleInfo.dtcs?.pending?.length || 0) +
      (vehicleInfo.dtcs?.permanent?.length || 0)
  );

  const baselineComparisons = baseline
    ? computeBaselineComparison(stats || [], baseline).map((c) => ({
        pidHex: c.pidHex,
        name: c.name,
        unit: c.unit,
        currentAvg: Number(c.currentAvg.toFixed(c.decimals)),
        baselineAvg: Number(c.baselineAvg.toFixed(c.decimals)),
        deltaAvg: Number(c.deltaAvg.toFixed(c.decimals)),
        pctDelta: c.pctDelta !== null ? Number(c.pctDelta.toFixed(1)) : null,
      }))
    : null;

  return {
    simulatedData: Boolean(isSimulated),
    sessionPurpose: sessionPurpose === 'buying' ? 'evaluating a used car' : 'own-vehicle troubleshooting',
    userNotes: userNotes || '',
    diagnosticProfile: activeProfile
      ? {
          id: activeProfile.id,
          name: activeProfile.name,
          category: activeProfile.category || 'custom',
          appliesTo: activeProfile.appliesTo || null,
          symptoms: activeProfile.symptoms || null,
          isCvtProfile: Boolean(activeProfile.isCvtProfile),
          analysisPrompt: activeProfile.analysisPrompt || '',
          driveScript: activeProfile.driveScript || [],
        }
      : null,
    cvtZeroDtcCaution: Boolean(activeProfile?.isCvtProfile && !hasAnyDtcs),
    adapterInfo: adapterInfo || null,
    telemetryHealth: pidHealthTracker?.toSummaryString
      ? pidHealthTracker.toSummaryString(pidMap)
      : 'all active PIDs steady',
    vehicleProfile: {
      manufacturer: mfrName,
      engine: engineName,
      transmission: profile.transId,
    },
    vin: vehicleInfo.vin || null,
    decodedMake: vehicleInfo.make || null,
    decodedYear: vehicleInfo.year || null,
    milOn: vehicleInfo.milOn,
    dtcCount: vehicleInfo.dtcCount,
    monitorsNotReady,
    clearHistory: {
      distanceWithMilKm: vehicleInfo.distanceWithMil,
      distanceSinceClearKm: vehicleInfo.distanceSinceClear,
      warmupsSinceClear: vehicleInfo.warmupsSinceClear,
      timeWithMilMin: vehicleInfo.timeWithMil,
      timeSinceClearMin: vehicleInfo.timeSinceClear,
    },
    dtcs: {
      stored: mapDtcs(vehicleInfo.dtcs?.stored, vehicleInfo.dtcDescriptions || {}),
      pending: mapDtcs(vehicleInfo.dtcs?.pending, vehicleInfo.dtcDescriptions || {}),
      permanent: mapDtcs(vehicleInfo.dtcs?.permanent, vehicleInfo.dtcDescriptions || {}),
    },
    recording: {
      sampleCount: records.length,
      duration_s: durationS,
    },
    activeDashboardPids: activeDashboard,
    sessionStatsPerPid: sessionStats,
    savedVehicleBaseline: baseline
      ? {
          label: baseline.label || 'Known-good baseline',
          savedAt: baseline.savedAt || null,
          sampleCount: baseline.sampleCount || 0,
          comparisons: baselineComparisons,
        }
      : null,
    markedMoments,
    markedMomentWindows,
  };
}

export function buildCompactStatsTable(stats) {
  if (!stats || stats.length === 0) {
    return 'Per-PID session summary: No telemetry samples recorded yet.';
  }
  const lines = ['PID | Name | Unit | Start | End | Min | Avg | Max | Samples'];
  for (const s of stats) {
    const startStr = s.first !== null && s.first !== undefined ? s.first.toFixed(s.decimals) : '—';
    const endStr = s.last !== null && s.last !== undefined ? s.last.toFixed(s.decimals) : '—';
    lines.push(
      `${s.pidHex} | ${s.name} | ${s.unit} | ${startStr} | ${endStr} | ${s.min.toFixed(s.decimals)} | ${s.avg.toFixed(s.decimals)} | ${s.max.toFixed(s.decimals)} | ${s.count}`
    );
  }
  return lines.join('\n');
}

function formatHttpError(provider, status, rawBody) {
  const provName = getProviderDisplayName(provider);
  if (status === 401) {
    return `API key rejected by ${provName}. Check the key in Settings.`;
  }
  if (status === 429) {
    return `Rate limited by ${provName}. Wait a moment and try again.`;
  }
  let detail = '';
  try {
    const parsed = JSON.parse(rawBody);
    detail = parsed?.error?.message || parsed?.message || rawBody;
  } catch {
    detail = rawBody;
  }
  const snippet = String(detail || '').trim().slice(0, 260);
  return `${provName} HTTP ${status}${snippet ? `: ${snippet}` : ''}`;
}

function formatNetworkOrCorsError(provider, err) {
  const msg = err?.message || String(err);
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed|cors/i.test(msg)) {
    if (provider === 'anthropic') {
      return `Request blocked or network error (${msg}). Note: Anthropic requires the anthropic-dangerous-direct-browser-access header (already included) and the provider must allow browser origins.`;
    }
    return `Request blocked by browser CORS policy or network error (${msg}). Verify your internet connection and that the provider allows browser origins.`;
  }
  return msg;
}

// Test connection with a minimal non-streaming request
export async function testAiConnection({ provider, model, apiKey }) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('No API key entered for this provider.');
  }
  const key = apiKey.trim();

  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          system: 'Reply with OK.',
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(formatHttpError('anthropic', res.status, text));
      }
      return `Connected to ${getModelDisplayName('anthropic', model)}.`;
    }

    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://bayscope.app',
          'X-Title': 'BayScope OBD-II',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [
            { role: 'system', content: 'Reply with OK.' },
            { role: 'user', content: 'ping' },
          ],
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(formatHttpError('openrouter', res.status, text));
      }
      return `Connected to ${getModelDisplayName('openrouter', model)} via OpenRouter.`;
    }

    // Gemini
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: 'Reply with OK.' }] },
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(formatHttpError('gemini', res.status, text));
    }
    return `Connected to ${getModelDisplayName('gemini', model)}.`;
  } catch (err) {
    if (err.message && (err.message.includes('HTTP ') || err.message.includes('API key rejected') || err.message.includes('Rate limited'))) {
      throw err;
    }
    throw new Error(formatNetworkOrCorsError(provider, err));
  }
}

// Stream chat completion from Anthropic, Google Gemini, or OpenRouter via SSE
export async function streamAiChat({
  provider,
  model,
  apiKey,
  systemPrompt,
  messages,
  signal,
  onDelta,
}) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error(`No API key configured for ${getProviderDisplayName(provider)}.`);
  }
  const key = apiKey.trim();

  let res;
  try {
    if (provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          system: systemPrompt,
          messages: messages.map((m) => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          })),
          stream: true,
        }),
      });
    } else if (provider === 'openrouter') {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://bayscope.app',
          'X-Title': 'BayScope OBD-II',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          stream: true,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages.map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            })),
          ],
        }),
      });
    } else {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
      res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
        }),
      });
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return { aborted: true };
    }
    throw new Error(formatNetworkOrCorsError(provider, err));
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(formatHttpError(provider, res.status, errText));
  }

  if (!res.body) {
    throw new Error('Streaming response body unavailable in this browser.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payloadStr = trimmed.slice(5).trim();
        if (!payloadStr || payloadStr === '[DONE]') continue;

        let evt;
        try {
          evt = JSON.parse(payloadStr);
        } catch {
          continue;
        }

        if (provider === 'anthropic') {
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            onDelta(evt.delta.text);
          } else if (evt.type === 'error') {
            throw new Error(evt.error?.message || 'Anthropic stream error');
          }
        } else if (provider === 'openrouter') {
          if (evt.error) {
            throw new Error(evt.error.message || 'OpenRouter stream error');
          }
          const deltaText = evt.choices?.[0]?.delta?.content;
          if (typeof deltaText === 'string' && deltaText.length > 0) {
            onDelta(deltaText);
          }
        } else {
          // Gemini SSE payload
          if (evt.error) {
            throw new Error(evt.error.message || 'Gemini stream error');
          }
          const parts = evt.candidates?.[0]?.content?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (part.text) onDelta(part.text);
            }
          }
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return { aborted: true };
    }
    const streamErr = new Error(err.message || 'Stream interrupted');
    streamErr.interrupted = true;
    throw streamErr;
  }

  return { aborted: false };
}
