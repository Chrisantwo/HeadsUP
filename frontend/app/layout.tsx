import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Storm Forecasting — Real-Time PAR Dashboard',
  description: 'Interactive weather forecasting for the Philippine Area of Responsibility',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-screen overflow-hidden">{children}</body>
    </html>
  )
}
