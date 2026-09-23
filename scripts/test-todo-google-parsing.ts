import assert from 'node:assert/strict'
import { extractGoogleDriveReferences } from '../src/shared/googleTodo.ts'

const text = [
  '文件 https://drive.google.com/file/d/file_ABC-123/view?usp=sharing',
  '文档 https://docs.google.com/document/d/doc_DEF-456/edit',
  '表格 https://docs.google.com/spreadsheets/d/sheet_GHI-789/edit#gid=0',
  '演示 https://docs.google.com/presentation/d/slide_JKL-012/edit',
  '文件夹 https://drive.google.com/drive/u/0/folders/folder_MNO-345',
  '旧链接 https://drive.google.com/open?usp=drive_link&id=open_PQR-678',
  '重复 https://drive.google.com/file/d/file_ABC-123/view',
  '伪造 https://drive.google.com.evil.example/file/d/not_allowed',
].join('\n')

const references = extractGoogleDriveReferences(text)
assert.deepEqual(references.map((entry) => entry.id), [
  'file_ABC-123',
  'open_PQR-678',
  'doc_DEF-456',
  'sheet_GHI-789',
  'slide_JKL-012',
  'folder_MNO-345',
])
assert.equal(references.filter((entry) => entry.id === 'file_ABC-123').length, 1)
assert.equal(references.some((entry) => entry.id === 'not_allowed'), false)

console.log('todo Google Drive reference parsing tests passed')
