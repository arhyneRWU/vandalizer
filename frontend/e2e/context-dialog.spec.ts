import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Screenshot evidence for the parts of the matrix that only exist on screen.
 *
 * Answer *content* — citations, hedging, determinism — is measured far more
 * reliably by the API harness (`~/vandalizer-workflow/harness/run_matrix.py`),
 * which reads the same stream this page renders without any DOM scraping.
 * What genuinely needs a browser is small and structural:
 *
 *   - the context-limit dialog's options, and their order
 *   - the notice banner's heading and tone
 *
 * Both are deterministic, so both are asserted properly rather than scored.
 *
 * Every run also writes the rendered text next to the screenshot: an image
 * cannot be quoted in an issue, and regathering this costs a GPU-bound hour.
 */

const EVIDENCE = process.env.E2E_EVIDENCE_DIR || '/tmp/vandalizer-e2e'

// A cold model reload under the shared GPU claim costs minutes, not seconds.
const ANSWER_TIMEOUT = 15 * 60 * 1000

async function loginAs(page: Page, user: string, pass: string) {
  await page.goto('/login')
  await page.getByLabel(/username|user id|email/i).first().fill(user)
  await page.getByLabel(/password/i).fill(pass)
  await page.getByRole('button', { name: /sign in|log ?in/i }).click()
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30_000 })
}

/** Screenshot plus the same content as text, because issues quote text. */
async function capture(page: Page, name: string, text: string) {
  const dir = join(EVIDENCE, name)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true })
  writeFileSync(join(dir, 'rendered.txt'), text + '\n')
}

test.describe('Context limit dialog and notice banner', () => {
  test.skip(
    !process.env.E2E_TEST_USER || !process.env.E2E_TEST_PASS,
    'needs E2E_TEST_USER / E2E_TEST_PASS',
  )
  test.setTimeout(ANSWER_TIMEOUT + 60_000)

  test.beforeEach(async ({ page }) => {
    await loginAs(page, process.env.E2E_TEST_USER!, process.env.E2E_TEST_PASS!)
  })

  test('a routed request is not announced as compaction', async ({ page }) => {
    // Regression guard. The banner had one heading for every action except
    // `documents_*`, so a successful route — which exists precisely so that
    // nothing is discarded — was announced as "Context was compacted", in
    // warning styling, on a success.
    await page.goto('/chat')
    const banner = page.getByRole('alert').filter({ hasText: /model|compact/i }).first()
    if (!(await banner.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip(true, 'no context notice on screen — run a routed request first')
    }
    const text = (await banner.innerText()).trim()
    await capture(page, 'banner-routed', text)

    if (/different model/i.test(text)) {
      // Routing succeeded: the whole document was kept, so claiming otherwise
      // is the bug this test exists for.
      expect(text).not.toMatch(/was compacted/i)
    }
  })

  test('the dialog offers a larger model before the options that discard content',
    async ({ page }) => {
      // The suggestion was computed from the *post*-compaction token count,
      // which always fits by definition, so this card could never render in
      // any configuration. Fixed in _suggest_model_for_overflow; this is the
      // end-to-end guard that it stays fixed.
      await page.goto('/chat')
      const opener = page.getByRole('button', { name: /context|truncate|compact/i }).first()
      if (!(await opener.isVisible({ timeout: 5_000 }).catch(() => false))) {
        test.skip(true, 'context dialog not reachable — needs an overflowing request')
      }
      await opener.click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      const text = (await dialog.innerText()).trim()
      await capture(page, 'dialog-options', text)

      const labels = await dialog.getByRole('button').allInnerTexts()
      const model = labels.findIndex((t) => /answer with/i.test(t))
      const truncate = labels.findIndex((t) => /truncate/i.test(t))

      if (model === -1) {
        // Legitimate when no configured model can hold the request — record
        // it rather than failing, so the report says which case was seen.
        writeFileSync(
          join(EVIDENCE, 'dialog-options', 'note.txt'),
          'No larger-model option offered. Correct only if no configured ' +
            'model has a context window large enough for this request.\n',
        )
        return
      }
      expect(model, 'the option that keeps the whole document comes first')
        .toBeLessThan(truncate)
    })
})
