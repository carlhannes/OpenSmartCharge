import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Nav from './components/Nav.js'
import Dashboard from './pages/Dashboard.js'
import Loadpoints from './pages/Loadpoints.js'
import Tariffs from './pages/Tariffs.js'
import Balancers from './pages/Balancers.js'
import Transactions from './pages/Transactions.js'
import Health from './pages/Health.js'

export default function App() {
  return (
    <BrowserRouter>
      <Nav />
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/loadpoints" element={<Loadpoints />} />
          <Route path="/tariffs" element={<Tariffs />} />
          <Route path="/balancers" element={<Balancers />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/health" element={<Health />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </BrowserRouter>
  )
}
