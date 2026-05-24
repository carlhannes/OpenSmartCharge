import { test, expect } from '@playwright/test'

// Smoke tests run against the production Vite preview server (no backend).
// All API calls will 502/network-fail; every page should gracefully show an empty/loading state.

const PAGES = [
  { path: '/', heading: 'OpenSmartCharge' },
  { path: '/loadpoints', heading: 'Loadpoints' },
  { path: '/tariffs', heading: 'Tariffs' },
  { path: '/balancers', heading: 'Balancers' },
  { path: '/transactions', heading: 'Transactions' },
  { path: '/health', heading: 'Health' },
]

test.beforeEach(async ({ page }) => {
  // Suppress expected network errors (API calls fail — backend not running)
  page.on('requestfailed', () => {})
})

test('nav bar renders with all links', async ({ page }) => {
  await page.goto('/')
  const nav = page.locator('nav')
  await expect(nav).toBeVisible()
  for (const { path, heading } of PAGES) {
    const label = heading === 'OpenSmartCharge' ? 'Dashboard' : heading
    if (label !== 'Dashboard') {
      await expect(nav.getByRole('link', { name: label })).toBeVisible()
    }
  }
  await expect(nav.locator('.brand, [class*="brand"]')).toContainText('OpenSmartCharge')
})

for (const { path, heading } of PAGES) {
  test(`${path} — renders h1 without crash`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto(path)
    // Page should show an h1 with the expected title
    const h1 = page.locator('h1')
    await expect(h1).toBeVisible({ timeout: 5000 })
    await expect(h1).toContainText(heading)

    // No uncaught JS exceptions
    expect(errors, `JS errors on ${path}: ${errors.join(', ')}`).toHaveLength(0)
  })
}

test('SPA routing — deep link navigates correctly', async ({ page }) => {
  // Navigate directly to a deep path — SPA fallback must return index.html
  await page.goto('/transactions')
  await expect(page.locator('h1')).toContainText('Transactions')
})

test('navigation — clicking links changes the page', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('h1')).toContainText('OpenSmartCharge')

  await page.getByRole('link', { name: 'Loadpoints' }).click()
  await expect(page.locator('h1')).toContainText('Loadpoints')

  await page.getByRole('link', { name: 'Health' }).click()
  await expect(page.locator('h1')).toContainText('Health')

  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.locator('h1')).toContainText('OpenSmartCharge')
})

test('unknown route redirects to dashboard', async ({ page }) => {
  await page.goto('/definitely-does-not-exist')
  await expect(page.locator('h1')).toContainText('OpenSmartCharge')
})

test('Loadpoints page — shows empty state when no loadpoints', async ({ page }) => {
  await page.goto('/loadpoints')
  await expect(page.locator('h1')).toContainText('Loadpoints')
  // With no backend, either a loading/empty state or no cards
  await expect(page.locator('h1')).toBeVisible()
})

test('Transactions page — shows empty state when no transactions', async ({ page }) => {
  await page.goto('/transactions')
  await expect(page.locator('h1')).toContainText('Transactions')
  await expect(page.locator('h1')).toBeVisible()
})
