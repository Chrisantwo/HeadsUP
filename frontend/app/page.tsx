import dynamic from 'next/dynamic'

// Load client-only dashboard — never SSR (Leaflet needs window)
const Dashboard = dynamic(() => import('@/components/Dashboard'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-screen bg-slate-900">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
        <span className="text-blue-400 text-xs tracking-widest uppercase">Initialising dashboard…</span>
      </div>
    </div>
  ),
})

export default function Page() {
  return <Dashboard />
}
