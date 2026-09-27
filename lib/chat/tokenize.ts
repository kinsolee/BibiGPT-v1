/** 检索分词：拉丁词元 + CJK 二元组（自用版轻量关键词匹配，不引入分词/向量依赖） */
export function tokenizeQuery(question: string): string[] {
  const terms = new Set<string>()
  for (const word of question.toLowerCase().match(/[a-z0-9][a-z0-9'-]+/g) ?? []) {
    terms.add(word)
  }
  for (const run of question.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []) {
    if (run.length === 1) {
      terms.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      terms.add(run.slice(i, i + 2))
    }
  }
  return Array.from(terms)
}
