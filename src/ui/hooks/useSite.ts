import { useState, useEffect } from 'react'
import { getSite, type SiteDto } from '../api/rest.js'

export function useSite() {
  const [site, setSite] = useState<SiteDto | null>(null)

  useEffect(() => {
    getSite().then(setSite).catch(console.error)
  }, [])

  return site
}
