import assert from 'node:assert/strict'
import { htmlMailToPlainText, normalizeMailBody } from '../src/shared/mailText.ts'

const malicious = `
  <style>body { display:none }</style>
  <script>steal(document.cookie)</script>
  <h1>项目提醒 &amp; 安排</h1>
  <p>请在周五前确认。<br>不要忘记回复。</p>
  <img src="https://tracker.example/open.gif">
  <iframe src="https://evil.example">fallback</iframe>
`

const plain = normalizeMailBody(htmlMailToPlainText(malicious))
assert.match(plain, /项目提醒 & 安排/)
assert.match(plain, /请在周五前确认。\n不要忘记回复。/)
assert.doesNotMatch(plain, /steal|display:none|tracker\.example|evil\.example|fallback/)
assert.equal(normalizeMailBody('第一段\r\n\r\n\r\n 第二段\u0000'), '第一段\n\n第二段')
assert.equal(normalizeMailBody('123456', 4), '1234')

console.log('todo mail plain-text sanitization tests passed')
