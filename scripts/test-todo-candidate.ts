import assert from 'node:assert/strict'
import { isTodoCandidateText } from '../src/shared/todoCandidate.ts'

for (const text of [
  '周末聚餐，地点晚点发你',
  '有空把合同发给我',
  '明天带上身份证',
  '我晚点联系客户',
  '下周一参加评审',
  '这个你看一下？',
]) assert.equal(isTodoCandidateText(text), true, `应保留潜在待办：${text}`)

for (const text of ['', '好', '[图片]', '哈哈哈哈']) {
  assert.equal(isTodoCandidateText(text), false, `普通消息不应进入模型：${text}`)
}

console.log('todo candidate recall tests passed')
