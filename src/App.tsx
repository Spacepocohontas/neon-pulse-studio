import { useCallback, useEffect, useRef, useState } from 'react'

type VizMode = 'bars' | 'wave' | 'particles' | 'tunnel' | 'ai'
type Project = {
  id: string
  name: string
  created: number
  prompt: string
  mode: VizMode
  hasAudio: boolean
}

const DB_NAME = 'neon-pulse-db'
const DB_VER = 1

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs')
      if (!db.objectStoreNames.contains('logs')) db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(store: string, key: string, value: unknown) {
  const db = await openDB()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDB()
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly')
    const r = tx.objectStore(store).getAll()
    r.onsuccess = () => res(r.result as T[])
    r.onerror = () => rej(r.error)
  })
}

async function idbDelete(store: string, key: string) {
  const db = await openDB()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

async function logActivity(msg: string) {
  try {
    const db = await openDB()
    const tx = db.transaction('logs', 'readwrite')
    tx.objectStore('logs').add({ ts: Date.now(), msg })
  } catch { /* ignore */ }
}

function formatTime(s: number) {
  if (!isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const overlayAudioRef = useRef<HTMLAudioElement>(null)
  const animRef = useRef(0)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunks = useRef<Blob[]>([])
  const particlesRef = useRef<{ x: number; y: number; vx: number; vy: number; life: number; hue: number }[]>([])
  const hueRef = useRef(270)

  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [mediaType, setMediaType] = useState<'audio' | 'video' | null>(null)
  const [fileName, setFileName] = useState('')
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.9)
  const [mutedOriginal, setMutedOriginal] = useState(false)
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null)
  const [vizMode, setVizMode] = useState<VizMode>('bars')
  const [prompt, setPrompt] = useState('')
  const [recording, setRecording] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [logs, setLogs] = useState<{ ts: number; msg: string }[]>([])
  const [tab, setTab] = useState<'upload' | 'prompt' | 'projects' | 'log'>('upload')
  const [toast, setToast] = useState<string | null>(null)
  const [bass, setBass] = useState(0.6)
  const [mid, setMid] = useState(0.7)
  const [treble, setTreble] = useState(0.8)
  const [sensitivity, setSensitivity] = useState(1.2)
  const [generated, setGenerated] = useState<{ id: string; label: string; canvas?: HTMLCanvasElement }[]>([])
  const [aiSeed, setAiSeed] = useState(0)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2800)
  }

  const refreshProjects = useCallback(async () => {
    try {
      const all = await idbGetAll<Project>('projects')
      setProjects(all.sort((a, b) => b.created - a.created))
    } catch { /* */ }
  }, [])

  const refreshLogs = useCallback(async () => {
    try {
      const all = await idbGetAll<{ ts: number; msg: string }>('logs')
      setLogs(all.slice(-40).reverse())
    } catch { /* */ }
  }, [])

  useEffect(() => {
    refreshProjects()
    refreshLogs()
  }, [refreshProjects, refreshLogs])

  const ensureAudioGraph = useCallback(() => {
    if (audioCtxRef.current) return
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.75
    analyserRef.current = analyser
    audioCtxRef.current = ctx
    const mediaEl = mediaType === 'video' ? videoRef.current : audioRef.current
    if (mediaEl) {
      try {
        const src = ctx.createMediaElementSource(mediaEl)
        src.connect(analyser)
        analyser.connect(ctx.destination)
      } catch { /* already connected */ }
    }
  }, [mediaType])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const resize = () => {
      const rect = canvas.parentElement!.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = () => {
      animRef.current = requestAnimationFrame(draw)
      const w = canvas.width / dpr
      const h = canvas.height / dpr
      const analyser = analyserRef.current
      let data: Uint8Array | null = null
      let timeData: Uint8Array | null = null
      if (analyser && playing) {
        data = new Uint8Array(analyser.frequencyBinCount)
        timeData = new Uint8Array(analyser.fftSize)
        analyser.getByteFrequencyData(data)
        analyser.getByteTimeDomainData(timeData)
      }
      if (vizMode === 'tunnel' || vizMode === 'ai') {
        ctx.fillStyle = 'rgba(5,5,12,0.18)'
        ctx.fillRect(0, 0, w, h)
      } else {
        ctx.fillStyle = '#05050c'
        ctx.fillRect(0, 0, w, h)
      }
      if (!data) {
        const t = performance.now() / 1000
        for (let i = 0; i < 40; i++) {
          const x = (Math.sin(t * 0.3 + i) * 0.5 + 0.5) * w
          const y = (Math.cos(t * 0.2 + i * 0.7) * 0.5 + 0.5) * h
          ctx.beginPath()
          ctx.arc(x, y, 1.5, 0, Math.PI * 2)
          ctx.fillStyle = `hsla(${270 + i * 3},70%,60%,0.3)`
          ctx.fill()
        }
        return
      }
      const bins = data.length
      const bassLevel = (data[2] + data[3] + data[4]) / 3 / 255 * sensitivity * bass
      const midLevel = (data[20] + data[30] + data[40]) / 3 / 255 * sensitivity * mid
      const trebLevel = (data[80] + data[100] + data[120]) / 3 / 255 * sensitivity * treble
      hueRef.current = (hueRef.current + bassLevel * 2) % 360

      if (vizMode === 'bars') {
        const barW = w / (bins / 2)
        for (let i = 0; i < bins / 2; i++) {
          const v = (data[i] / 255) * sensitivity
          const barH = v * h * 0.85
          const hue = (i / (bins / 2)) * 120 + hueRef.current
          const grad = ctx.createLinearGradient(0, h, 0, h - barH)
          grad.addColorStop(0, `hsla(${hue},90%,50%,0.2)`)
          grad.addColorStop(1, `hsla(${hue},90%,65%,0.95)`)
          ctx.fillStyle = grad
          ctx.fillRect(i * barW, h - barH, barW - 1.5, barH)
        }
      } else if (vizMode === 'wave') {
        if (timeData) {
          ctx.beginPath()
          ctx.lineWidth = 2.5
          ctx.strokeStyle = `hsla(${hueRef.current},85%,65%,0.9)`
          ctx.shadowBlur = 12
          ctx.shadowColor = `hsla(${hueRef.current},90%,50%,0.6)`
          for (let i = 0; i < timeData.length; i++) {
            const x = (i / timeData.length) * w
            const y = ((timeData[i] - 128) / 128) * (h * 0.35 * sensitivity) + h / 2
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
          }
          ctx.stroke()
          ctx.shadowBlur = 0
        }
        ctx.beginPath()
        ctx.strokeStyle = `hsla(${(hueRef.current + 80) % 360},70%,55%,0.4)`
        ctx.lineWidth = 1.5
        for (let i = 0; i < bins / 3; i++) {
          const x = (i / (bins / 3)) * w
          const y = h - (data[i] / 255) * h * 0.4 * sensitivity
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        }
        ctx.stroke()
      } else if (vizMode === 'particles') {
        const count = Math.floor(bassLevel * 8 + midLevel * 4)
        for (let i = 0; i < count; i++) {
          particlesRef.current.push({
            x: w / 2 + (Math.random() - 0.5) * 40,
            y: h / 2 + (Math.random() - 0.5) * 40,
            vx: (Math.random() - 0.5) * (4 + bassLevel * 8),
            vy: (Math.random() - 0.5) * (4 + bassLevel * 8),
            life: 1,
            hue: hueRef.current + Math.random() * 60,
          })
        }
        if (particlesRef.current.length > 400) particlesRef.current = particlesRef.current.slice(-300)
        particlesRef.current.forEach((p) => {
          p.x += p.vx; p.y += p.vy
          p.life -= 0.012 + (1 - bassLevel) * 0.01
          p.vx *= 0.99; p.vy *= 0.99
          if (p.life > 0) {
            ctx.beginPath()
            ctx.arc(p.x, p.y, 2 + bassLevel * 3, 0, Math.PI * 2)
            ctx.fillStyle = `hsla(${p.hue},90%,60%,${p.life})`
            ctx.fill()
          }
        })
        particlesRef.current = particlesRef.current.filter((p) => p.life > 0)
      } else if (vizMode === 'tunnel') {
        const cx = w / 2, cy = h / 2
        for (let i = 0; i < 18; i++) {
          const t = (performance.now() / 800 + i / 18) % 1
          const r = t * Math.max(w, h) * 0.7
          const alpha = (1 - t) * (0.3 + bassLevel * 0.5)
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.strokeStyle = `hsla(${(hueRef.current + i * 12) % 360},85%,60%,${alpha})`
          ctx.lineWidth = 2 + midLevel * 4
          ctx.stroke()
        }
        ctx.beginPath()
        ctx.arc(cx, cy, 20 + bassLevel * 60, 0, Math.PI * 2)
        ctx.fillStyle = `hsla(${hueRef.current},90%,55%,${0.2 + bassLevel * 0.4})`
        ctx.fill()
      } else if (vizMode === 'ai') {
        const seed = aiSeed || 42
        const t = performance.now() / 1000
        for (let L = 0; L < 6; L++) {
          const n = 8 + L * 3
          ctx.beginPath()
          for (let i = 0; i <= n; i++) {
            const a = (i / n) * Math.PI * 2
            const beat = (data[Math.floor((i / n) * 40)] / 255) * sensitivity
            const r = 40 + L * 28 + Math.sin(a * (3 + (seed % 5)) + t * (1 + L * 0.2) + seed) * (20 + bassLevel * 40) + beat * 50
            const x = w / 2 + Math.cos(a + t * 0.15 * (L + 1)) * r
            const y = h / 2 + Math.sin(a + t * 0.12 * (L + 1)) * r * 0.85
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
          }
          ctx.closePath()
          const hue = (hueRef.current + L * 35 + seed * 3) % 360
          ctx.strokeStyle = `hsla(${hue},80%,${55 + midLevel * 20}%,${0.25 + trebLevel * 0.35})`
          ctx.lineWidth = 1.5 + bassLevel * 2
          ctx.stroke()
          if (L === 0) { ctx.fillStyle = `hsla(${hue},70%,40%,0.08)`; ctx.fill() }
        }
        const glyphs = Math.min(12, 3 + Math.floor(prompt.length / 12))
        for (let g = 0; g < glyphs; g++) {
          const gx = (Math.sin(t * 0.4 + g * 1.7 + seed) * 0.5 + 0.5) * w
          const gy = (Math.cos(t * 0.3 + g * 2.1) * 0.5 + 0.5) * h
          ctx.font = `${10 + bassLevel * 14}px Orbitron`
          ctx.fillStyle = `hsla(${(hueRef.current + g * 40) % 360},90%,70%,${0.3 + midLevel * 0.4})`
          ctx.fillText('◆◇◈'[g % 3], gx, gy)
        }
      }
    }
    draw()
    return () => {
      cancelAnimationFrame(animRef.current)
      window.removeEventListener('resize', resize)
    }
  }, [playing, vizMode, bass, mid, treble, sensitivity, aiSeed, prompt])

  const handleFile = async (file: File) => {
    const url = URL.createObjectURL(file)
    const isVideo = file.type.startsWith('video/')
    setMediaUrl(url)
    setMediaType(isVideo ? 'video' : 'audio')
    setFileName(file.name)
    setPlaying(false)
    setCurrentTime(0)
    if (audioCtxRef.current) {
      try { await audioCtxRef.current.close() } catch { /* */ }
      audioCtxRef.current = null
      analyserRef.current = null
    }
    await logActivity(`Loaded media: ${file.name}`)
    refreshLogs()
    showToast(`Loaded ${file.name}`)
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }

  const togglePlay = async () => {
    ensureAudioGraph()
    if (audioCtxRef.current?.state === 'suspended') await audioCtxRef.current.resume()
    const el = mediaType === 'video' ? videoRef.current : audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
      overlayAudioRef.current?.pause()
      setPlaying(false)
    } else {
      await el.play()
      if (overlayUrl && overlayAudioRef.current) {
        overlayAudioRef.current.currentTime = el.currentTime
        await overlayAudioRef.current.play().catch(() => {})
      }
      setPlaying(true)
    }
  }

  const onTimeUpdate = () => {
    const el = mediaType === 'video' ? videoRef.current : audioRef.current
    if (el) {
      setCurrentTime(el.currentTime)
      setDuration(el.duration || 0)
      if (overlayAudioRef.current && Math.abs(overlayAudioRef.current.currentTime - el.currentTime) > 0.3) {
        overlayAudioRef.current.currentTime = el.currentTime
      }
    }
  }

  const seek = (v: number) => {
    const el = mediaType === 'video' ? videoRef.current : audioRef.current
    if (el) {
      el.currentTime = v
      if (overlayAudioRef.current) overlayAudioRef.current.currentTime = v
      setCurrentTime(v)
    }
  }

  useEffect(() => {
    const el = mediaType === 'video' ? videoRef.current : audioRef.current
    if (el) {
      el.volume = mutedOriginal ? 0 : volume
      el.muted = mutedOriginal
    }
  }, [volume, mutedOriginal, mediaType, mediaUrl])

  useEffect(() => {
    if (overlayAudioRef.current) overlayAudioRef.current.volume = volume
  }, [volume, overlayUrl])

  const startRecording = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const stream = canvas.captureStream(30)
    recordedChunks.current = []
    const mr = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm',
    })
    mr.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.current.push(e.data) }
    mr.onstop = () => {
      const blob = new Blob(recordedChunks.current, { type: 'video/webm' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `neon-pulse-${Date.now()}.webm`
      a.click()
      URL.revokeObjectURL(url)
      showToast('Visualization downloaded')
      logActivity('Exported live visualization recording')
      refreshLogs()
    }
    mediaRecorderRef.current = mr
    mr.start(200)
    setRecording(true)
    showToast('Recording visualization…')
  }

  const stopRecording = () => {
    mediaRecorderRef.current?.stop()
    setRecording(false)
  }

  const saveProject = async () => {
    if (!fileName && !prompt) {
      showToast('Load media or write a prompt first')
      return
    }
    const id = `proj_${Date.now()}`
    const p: Project = {
      id,
      name: fileName || prompt.slice(0, 40) || 'Untitled',
      created: Date.now(),
      prompt,
      mode: vizMode,
      hasAudio: !!mediaUrl,
    }
    await idbPut('projects', id, p)
    await logActivity(`Saved project: ${p.name}`)
    await refreshProjects()
    await refreshLogs()
    showToast('Project saved to browser storage')
  }

  const loadProject = async (p: Project) => {
    setPrompt(p.prompt)
    setVizMode(p.mode)
    setTab('prompt')
    showToast(`Loaded project settings: ${p.name}`)
    await logActivity(`Opened project: ${p.name}`)
    refreshLogs()
  }

  const deleteProject = async (id: string) => {
    await idbDelete('projects', id)
    await refreshProjects()
    showToast('Project deleted')
  }

  const generateVideos = async () => {
    const count = 4
    const newOnes: { id: string; label: string; canvas?: HTMLCanvasElement }[] = []
    const seedBase = prompt.split('').reduce((a, c) => a + c.charCodeAt(0), 0) || Date.now()
    setAiSeed(seedBase)
    for (let i = 0; i < count; i++) {
      const c = document.createElement('canvas')
      c.width = 640
      c.height = 360
      const g = c.getContext('2d')!
      g.fillStyle = '#05050c'
      g.fillRect(0, 0, 640, 360)
      const localSeed = seedBase + i * 97
      for (let L = 0; L < 8; L++) {
        g.beginPath()
        for (let j = 0; j <= 24; j++) {
          const a = (j / 24) * Math.PI * 2
          const r = 30 + L * 22 + Math.sin(a * (2 + (localSeed % 4)) + L) * 25
          const x = 320 + Math.cos(a + localSeed * 0.01) * r
          const y = 180 + Math.sin(a + localSeed * 0.01) * r * 0.8
          j === 0 ? g.moveTo(x, y) : g.lineTo(x, y)
        }
        g.closePath()
        const hue = (270 + localSeed * 3 + L * 30 + i * 40) % 360
        g.strokeStyle = `hsla(${hue},85%,60%,0.7)`
        g.lineWidth = 2
        g.stroke()
      }
      g.font = '14px Orbitron'
      g.fillStyle = 'rgba(255,255,255,0.35)'
      g.fillText((prompt || 'AI VISUAL').slice(0, 42).toUpperCase(), 16, 340)
      newOnes.push({
        id: `gen_${Date.now()}_${i}`,
        label: prompt ? `AI · ${prompt.slice(0, 18)}… #${i + 1}` : `Beat Visual #${i + 1}`,
        canvas: c,
      })
    }
    setGenerated(newOnes)
    setVizMode('ai')
    await logActivity(`Generated ${count} AI visual frames${prompt ? ` for prompt: ${prompt.slice(0, 40)}` : ''}`)
    refreshLogs()
    showToast(`Generated ${count} visual concepts`)
  }

  const handleOverlayTrack = (file: File) => {
    const url = URL.createObjectURL(file)
    setOverlayUrl(url)
    setMutedOriginal(true)
    showToast('Overlay track loaded — original muted')
    logActivity(`Overlay audio: ${file.name}`)
    refreshLogs()
  }

  return (
    <div className="app">
      <header className="header">
        <div className="logo">NEON PULSE STUDIO</div>
        <div className="header-actions">
          <button className="primary" onClick={saveProject}>Save Project</button>
          {!recording ? (
            <button onClick={startRecording} disabled={!mediaUrl && vizMode !== 'ai'}>● Rec Viz</button>
          ) : (
            <button className="danger" onClick={stopRecording}>■ Stop & Download</button>
          )}
        </div>
      </header>

      <div className="grid">
        <div>
          <div className="panel">
            <div className="mode-pills">
              {(['bars', 'wave', 'particles', 'tunnel', 'ai'] as VizMode[]).map((m) => (
                <button key={m} className={vizMode === m ? 'active' : ''} onClick={() => setVizMode(m)}>{m}</button>
              ))}
            </div>
            <div className="viz-wrap">
              <canvas ref={canvasRef} />
              {mediaType === 'video' && mediaUrl && (
                <video ref={videoRef} src={mediaUrl} style={{ position: 'absolute', inset: 0, opacity: 0.35, pointerEvents: 'none' }} onTimeUpdate={onTimeUpdate} onEnded={() => setPlaying(false)} playsInline />
              )}
              {mediaType === 'audio' && mediaUrl && (
                <audio ref={audioRef} src={mediaUrl} onTimeUpdate={onTimeUpdate} onEnded={() => setPlaying(false)} />
              )}
              {overlayUrl && <audio ref={overlayAudioRef} src={overlayUrl} />}
              <div className="viz-overlay">
                <div className="track-title">{fileName || (prompt ? `AI · ${prompt.slice(0, 48)}` : 'Drop a track to begin')}</div>
              </div>
            </div>
            <div className="controls">
              <button className="primary" onClick={togglePlay} disabled={!mediaUrl}>{playing ? 'Pause' : 'Play'}</button>
              <span className="time">{formatTime(currentTime)} / {formatTime(duration)}</span>
              <input className="seek" type="range" min={0} max={duration || 0} step={0.01} value={currentTime} onChange={(e) => seek(Number(e.target.value))} disabled={!mediaUrl} />
              <label style={{ fontSize: 12, color: 'var(--muted)' }}>Vol</label>
              <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} style={{ width: 80 }} />
              <button onClick={() => setMutedOriginal((m) => !m)} title="Mute original audio">{mutedOriginal ? '🔇 Orig Muted' : '🔊 Orig Audio'}</button>
            </div>
            <div className="dj-grid">
              <div className="knob-group"><label>Bass {Math.round(bass * 100)}</label><input type="range" min={0} max={2} step={0.01} value={bass} onChange={(e) => setBass(Number(e.target.value))} /></div>
              <div className="knob-group"><label>Mid {Math.round(mid * 100)}</label><input type="range" min={0} max={2} step={0.01} value={mid} onChange={(e) => setMid(Number(e.target.value))} /></div>
              <div className="knob-group"><label>Treble {Math.round(treble * 100)}</label><input type="range" min={0} max={2} step={0.01} value={treble} onChange={(e) => setTreble(Number(e.target.value))} /></div>
              <div className="knob-group"><label>Sensitivity {sensitivity.toFixed(1)}</label><input type="range" min={0.3} max={3} step={0.05} value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} /></div>
            </div>
            <div className="status-bar">
              {playing && <span className="badge live">● LIVE</span>}
              {recording && <span className="badge rec">● REC</span>}
              <span className="badge">{vizMode.toUpperCase()}</span>
              {mutedOriginal && <span className="badge">ORIG MUTED</span>}
              {overlayUrl && <span className="badge">OVERLAY TRACK</span>}
            </div>
          </div>
        </div>

        <div className="sidebar">
          <div className="panel">
            <div className="tabs">
              <button className={tab === 'upload' ? 'active' : ''} onClick={() => setTab('upload')}>Media</button>
              <button className={tab === 'prompt' ? 'active' : ''} onClick={() => setTab('prompt')}>AI Prompt</button>
              <button className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>Projects</button>
              <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>Log</button>
            </div>
            {tab === 'upload' && (
              <>
                <div className="upload-zone" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onClick={() => document.getElementById('file-input')?.click()}>
                  <strong>Drop audio / video</strong>
                  mp3 · mp4 · wav · webm · mov
                </div>
                <input id="file-input" type="file" accept="audio/*,video/*" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
                <div style={{ marginTop: 12 }}>
                  <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Overlay your own track (mutes original)</label>
                  <button onClick={() => document.getElementById('overlay-input')?.click()} style={{ width: '100%' }}>+ Replace Audio Track</button>
                  <input id="overlay-input" type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && handleOverlayTrack(e.target.files[0])} />
                </div>
              </>
            )}
            {tab === 'prompt' && (
              <div className="prompt-box">
                <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Describe the music video mood. AI mode reacts to beats + your prompt.</p>
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="neon cyberpunk city rain, obsessive violet eyes, dark romance pulse…" />
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="primary" style={{ flex: 1 }} onClick={generateVideos}>Generate Visuals</button>
                  <button onClick={() => { setVizMode('ai'); setAiSeed(Date.now()) }}>Live AI Mode</button>
                </div>
                {generated.length > 0 && (
                  <div className="gen-grid" style={{ marginTop: 12 }}>
                    {generated.map((g) => (
                      <div key={g.id} className="gen-card">
                        {g.canvas && <img src={g.canvas.toDataURL('image/png')} alt={g.label} />}
                        <div>{g.label}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {tab === 'projects' && (
              <div className="project-list">
                {projects.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No saved projects yet. Hit Save Project.</div>}
                {projects.map((p) => (
                  <div key={p.id} className="project-item">
                    <div>
                      <div className="name">{p.name}</div>
                      <div className="meta">{new Date(p.created).toLocaleString()} · {p.mode}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={() => loadProject(p)}>Open</button>
                      <button className="danger" onClick={() => deleteProject(p.id)}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {tab === 'log' && (
              <div className="log-list">
                {logs.length === 0 && <div>Activity will appear here.</div>}
                {logs.map((l, i) => (
                  <div key={i}><span style={{ color: 'var(--accent2)' }}>{new Date(l.ts).toLocaleTimeString()}</span>{' — '}{l.msg}</div>
                ))}
              </div>
            )}
          </div>
          <div className="panel">
            <h2>Quick tips</h2>
            <ul style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55, paddingLeft: 16 }}>
              <li>Upload a track → pick a viz mode → hit Play</li>
              <li>● Rec Viz captures the live canvas as .webm</li>
              <li>Mute original + overlay = TikTok-style swap</li>
              <li>Prompt + Generate creates multiple AI concepts</li>
              <li>Projects & activity log live in your browser (IndexedDB)</li>
            </ul>
          </div>
        </div>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
