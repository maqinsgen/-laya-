export interface GoogleDriveReference {
  id: string
  url: string
}

/** Extract only well-known Google Drive/Workspace file URLs from untrusted text. */
export function extractGoogleDriveReferences(text: string): GoogleDriveReference[] {
  const results = new Map<string, string>()
  const patterns = [
    /https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/gi,
    /https?:\/\/drive\.google\.com\/(?:open|uc)\?[^\s<>"']*?id=([a-zA-Z0-9_-]+)/gi,
    /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/gi,
    /https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/gi,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) results.set(match[1], match[0])
  }
  return [...results].map(([id, url]) => ({ id, url }))
}
