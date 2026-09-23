/**
 * 只做高召回、低成本预筛；最终是否为待办仍由模型结合收发方向判断。
 * 这里宁可多送一条普通消息，也不要漏掉短促的请求或承诺。
 */
export function isTodoCandidateText(value: unknown): boolean {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text || text.length < 2 || /^\[[^\]]+\]$/.test(text)) return false
  return /(今天|明天|后天|大后天|本周|下周|周末|月底|月初|近期|稍后|晚点|有空|改天|周[一二三四五六日天]|星期|\d{1,2}[点时:]|\d{1,2}[月/-]\d{1,2}|记得|别忘|需要|要做|麻烦|请|安排|提交|完成|回复|确认|跟进|提醒|预约|截止|发送|发给|转给|交给|带上|带来|拿来|取走|购买|买下|修改|改好|签字|签署|联系|打电话|参加|开会|聚餐|见面|到场|准备|处理|查一下|看一下|deadline|todo|follow\s?up|google\.com\/|drive\.google\.com\/)/i.test(text)
    || /[?？]$/.test(text)
}
