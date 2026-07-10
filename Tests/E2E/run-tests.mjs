import { chromium, firefox, webkit } from 'playwright';

const BASE = process.env.E2E_BASE_URL || 'http://basewebsite.ddev.site';
const TOKEN = process.env.ASANA_FEEDBACK_ACCESS_TOKEN;
if (!TOKEN) throw new Error('Set ASANA_FEEDBACK_ACCESS_TOKEN');
const PROJECT_GID = '1216274953146548';
const SECTION_GID = '1216274953146549'; // "Todo"
const YURII_GID = '510973132418883';
const RUN_MARKER = `cqaf-e2e-${Date.now()}`;

const results = [];
const createdTaskGids = [];

function log(...args) { console.log(new Date().toISOString().slice(11, 19), ...args); }

async function asana(method, path, body) {
    const response = await fetch(`https://app.asana.com/api/1.0${path}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Asana ${method} ${path} -> ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    return payload.data;
}

async function findTaskByMarker(marker) {
    // tasks land at the top of the section; look through the newest 100
    const tasks = await asana('GET', `/sections/${SECTION_GID}/tasks?opt_fields=name,notes,assignee.gid,assignee.name,permalink_url,memberships.section.gid&limit=100`);
    return tasks.find((task) => task.name.includes(marker) || (task.notes || '').includes(marker));
}

async function neosLogin(page, username, password) {
    await page.goto(`${BASE}/neos`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name*="username"]', username);
    await page.fill('input[name*="password"]', password);
    await Promise.all([
        page.waitForURL('**/neos**', { timeout: 30000 }),
        page.click('button[type="submit"]'),
    ]);
    // the backend UI is heavy; we only need the session cookie
    await page.waitForTimeout(1500);
}

async function drawAllAnnotations(page) {
    const canvas = page.locator('.cqaf-annotator canvas.upper-canvas');
    await canvas.waitFor({ state: 'visible', timeout: 20000 });
    const box = await canvas.boundingBox();
    const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];

    // freehand (pen is preselected)
    await page.mouse.move(...at(0.1, 0.2));
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(...at(0.1 + i * 0.04, 0.2 + i * 0.03));
    await page.mouse.up();

    // rectangle
    await page.click('[data-tool="rect"]');
    await page.mouse.move(...at(0.45, 0.2));
    await page.mouse.down();
    await page.mouse.move(...at(0.6, 0.4), { steps: 4 });
    await page.mouse.up();

    // arrow
    await page.click('[data-tool="arrow"]');
    await page.mouse.move(...at(0.7, 0.2));
    await page.mouse.down();
    await page.mouse.move(...at(0.8, 0.45), { steps: 4 });
    await page.mouse.up();

    // text
    await page.click('[data-tool="text"]');
    await page.mouse.click(...at(0.3, 0.6));
    await page.keyboard.type('E2E annotation');
    await page.keyboard.press('Escape');

    // undo/redo/undo-history sanity (buttons enable once history states exist)
    await page.locator('[data-action="undo"]:not([disabled])').waitFor({ timeout: 10000 });
    await page.click('[data-action="undo"]');
    await page.locator('[data-action="redo"]:not([disabled])').waitFor({ timeout: 10000 });
    await page.click('[data-action="redo"]');
    await page.waitForTimeout(300);

    // delete: select the rectangle via select tool, click into it, remove, undo again
    await page.click('[data-tool="select"]');
    await page.mouse.click(...at(0.52, 0.3));
    await page.click('[data-action="delete"]');
    await page.waitForTimeout(200);
    await page.click('[data-action="undo"]');
    await page.waitForTimeout(300);
}

async function runFeedbackFlow(page, { description, authorName, assigneeKey, expectAssigneeUi, expectTaskLink }) {
    await page.locator('.cqaf-fab').waitFor({ state: 'visible', timeout: 20000 });
    await page.click('.cqaf-fab');

    // capture can take a while on a DOM heavy page
    await page.locator('.cqaf-annotator').waitFor({ state: 'visible', timeout: 60000 });
    await drawAllAnnotations(page);
    await page.click('[data-action="continue"]');

    const form = page.locator('.cqaf-form');
    await form.waitFor({ state: 'visible', timeout: 15000 });

    // screenshot preview must be visible before sending
    if (!(await page.locator('.cqaf-form__preview').isVisible())) throw new Error('screenshot preview missing');

    const assigneeCount = await page.locator('.cqaf-assignee').count();
    if (expectAssigneeUi && assigneeCount !== 3) throw new Error(`expected 3 assignees, saw ${assigneeCount}`);
    if (!expectAssigneeUi && assigneeCount !== 0) throw new Error(`assignee UI visible for non-team user (${assigneeCount})`);

    await page.fill('#cqaf-description', description);
    if (authorName !== null) await page.fill('#cqaf-author', authorName);
    if (assigneeKey) await page.click(`.cqaf-assignee[data-key="${assigneeKey}"]`);

    const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('codeq-asana-feedback/submit'), { timeout: 90000 }),
        page.click('.cqaf-form button[type="submit"]'),
    ]);
    const payload = await response.json();

    await page.locator('.cqaf-panel--result').waitFor({ state: 'visible', timeout: 15000 });
    const success = await page.locator('.cqaf-result__icon--success').count();
    if (!success) throw new Error(`no success state, response: ${JSON.stringify(payload).slice(0, 300)}`);

    const taskLinkCount = await page.locator('.cqaf-task-link').count();
    if (expectTaskLink && taskLinkCount !== 1) throw new Error('expected Asana task link for team member');
    if (!expectTaskLink && taskLinkCount !== 0) throw new Error('task link exposed to non-team user');

    return payload;
}

async function verifyTaskInAsana({ marker, expectedAuthor, expectedAssigneeName }) {
    let task = null;
    for (let attempt = 0; attempt < 5 && !task; attempt++) {
        task = await findTaskByMarker(marker);
        if (!task) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!task) throw new Error(`task with marker ${marker} not found in Todo section`);
    createdTaskGids.push(task.gid);

    if (!(task.notes || '').includes(`Autor: ${expectedAuthor}`)) throw new Error(`author missing in notes: ${task.notes.slice(0, 200)}`);
    if (!(task.notes || '').includes('URL: http://basewebsite.ddev.site')) throw new Error('page URL missing in notes');
    if (!(task.notes || '').includes('Erstellt am:')) throw new Error('timestamp missing in notes');
    if (!(task.notes || '').includes('Browser:')) throw new Error('technical context missing in notes');

    const actualAssignee = task.assignee ? task.assignee.name : null;
    if ((expectedAssigneeName || null) !== actualAssignee) throw new Error(`assignee mismatch: expected ${expectedAssigneeName}, got ${actualAssignee}`);

    const attachments = await asana('GET', `/attachments?parent=${task.gid}&opt_fields=name,size`);
    if (attachments.length < 1) throw new Error('no attachment on task');
    return { taskGid: task.gid, attachments: attachments.length };
}

async function testScenario(name, browserType, scenarioFn) {
    log(`=== ${name} ===`);
    const browser = await browserType.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.on('pageerror', (error) => log(`  [pageerror] ${error.message.slice(0, 200)}`));
    try {
        await scenarioFn(page);
        results.push({ name, ok: true });
        log(`  PASS ${name}`);
    } catch (error) {
        results.push({ name, ok: false, error: error.message });
        log(`  FAIL ${name}: ${error.message}`);
        try { await page.screenshot({ path: `fail-${name.replace(/[^a-z0-9]/gi, '_')}.png` }); } catch {}
    } finally {
        await browser.close();
    }
}

const engines = { chromium, firefox, webkit };

for (const [engineName, engine] of Object.entries(engines)) {
    await testScenario(`${engineName}-anonymous`, engine, async (page) => {
        await page.goto(BASE, { waitUntil: 'load' });
        const marker = `${RUN_MARKER}-${engineName}-anon`;
        await runFeedbackFlow(page, {
            description: `E2E Test anonym (${engineName}) ${marker}`,
            authorName: 'E2E Testbot',
            assigneeKey: null,
            expectAssigneeUi: false,
            expectTaskLink: false,
        });
        const verification = await verifyTaskInAsana({ marker, expectedAuthor: 'E2E Testbot', expectedAssigneeName: null });
        log(`  task ${verification.taskGid} verified, ${verification.attachments} attachment(s)`);
    });
}

await testScenario('chromium-admin-non-team', chromium, async (page) => {
    await neosLogin(page, 'admin', 'admin');
    await page.goto(BASE, { waitUntil: 'load' });
    const marker = `${RUN_MARKER}-admin`;
    // author field must not exist for logged-in users, name comes from the server
    await runFeedbackFlow(page, {
        description: `E2E Test angemeldet ohne Team (${marker})`,
        authorName: null,
        assigneeKey: null,
        expectAssigneeUi: false,
        expectTaskLink: false,
    });
    const verification = await verifyTaskInAsana({ marker, expectedAuthor: 'Admin Admin', expectedAssigneeName: null });
    log(`  task ${verification.taskGid} verified, ${verification.attachments} attachment(s)`);
});

await testScenario('chromium-team-roland', chromium, async (page) => {
    await neosLogin(page, process.env.E2E_TEAM_USER || 'roland.schuetz', process.env.E2E_TEAM_PASSWORD || 'codeq-e2e-Test1');
    await page.goto(BASE, { waitUntil: 'load' });
    const marker = `${RUN_MARKER}-team`;
    await runFeedbackFlow(page, {
        description: `E2E Test Teammitglied (${marker})`,
        authorName: null,
        assigneeKey: 'yurii',
        expectAssigneeUi: true,
        expectTaskLink: true,
    });
    const verification = await verifyTaskInAsana({ marker, expectedAuthor: 'Roland Schuetz', expectedAssigneeName: 'Yurii Kosynets' });
    log(`  task ${verification.taskGid} verified, ${verification.attachments} attachment(s)`);
});

// ---- cleanup: remove all E2E tasks from Asana ----
for (const taskGid of createdTaskGids) {
    try {
        await asana('DELETE', `/tasks/${taskGid}`);
        log(`cleaned up task ${taskGid}`);
    } catch (error) {
        log(`cleanup failed for ${taskGid}: ${error.message}`);
    }
}

log('\n==== SUMMARY ====');
for (const result of results) log(result.ok ? `PASS ${result.name}` : `FAIL ${result.name}: ${result.error}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
