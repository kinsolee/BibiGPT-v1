// KIN-48 单测公共 harness（无测试框架，Node 直跑）。
let passed = 0
const failures: string[] = []

/** 每个套件开始前重置计数，summary 输出本套件结果 */
export function resetSuite(): void {
  passed = 0
  failures.length = 0
}

export function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1
    console.log(`  ok - ${name}`)
  } else {
    failures.push(name)
    console.error(`  FAIL - ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ''}`)
  }
}

export function checkEqual(name: string, actual: unknown, expected: unknown): void {
  const equal = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, equal, equal ? undefined : { actual, expected })
}

export function summary(suite: string): void {
  console.log(`\n[${suite}] passed=${passed} failed=${failures.length}`)
  if (failures.length) {
    console.error(`failed cases:\n - ${failures.join('\n - ')}`)
  }
}

export function hasFailures(): boolean {
  return failures.length > 0
}
