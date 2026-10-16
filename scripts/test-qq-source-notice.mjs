import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const compile = (path, replacements = {}) => {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  let { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } });
  for (const [key, value] of Object.entries(replacements)) outputText = outputText.replaceAll(`"${key}"`, JSON.stringify(value));
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
};
const session = compile('../src/utils/qqSession.ts');
const noticeModule = compile('../src/utils/qqSourceNotice.ts', { './qqSession': session });
const { qqSourceNotice, qqProgressNotice } = await import(noticeModule);
const { describeError, diagnosticError, describeLicenseError } = await import(compile('../src/utils/uiError.ts', { './qqSession': session, './qqSourceNotice': noticeModule }));

const reasons = [
  'QQ_REQUEST_BLOCKED: 历史消息请求被 QQ 空间拦截（HTTP 501）',
  'ARCHIVE_INTERACTIONS_UNAVAILABLE:QQ_REQUEST_BLOCKED: 互动通知请求被 QQ 空间拦截（HTTP 501）',
  '获取空间动态失败：腾讯 WAF 拦截了移动端互动接口（HTTP 501 Not Implemented）',
  'QQ_SOURCE_BUSY: QQ 空间历史接口繁忙',
  new Error('HTTP 501 Not Implemented'),
];
for (const reason of reasons) {
  assert.ok(qqSourceNotice(reason));
  assert.doesNotMatch(qqSourceNotice(reason), /501|WAF|QQ_REQUEST|错误|失败/);
  for (const status of ['limited', 'partial', 'error']) {
    const progress = { status, message: String(reason), pages: 2, saved: 9 };
    const original = { ...progress };
    const notice = qqProgressNotice(progress);
    assert.ok(notice);
    assert.doesNotMatch(JSON.stringify(notice), /501|WAF|错误|失败|已完成/);
    assert.match(notice.details, /2 页.*9 条/);
    assert.deepEqual(progress, original, 'Presentation must not change completeness or native diagnostics');
  }
}
for (const reason of reasons.slice(0, 4)) {
  assert.doesNotMatch(describeError(reason), /501|WAF|QQ_REQUEST|错误|失败/);
  assert.doesNotMatch(diagnosticError(reason), /501|WAF|QQ_REQUEST|错误|失败/);
}
for (const message of ['QQ_LOGIN_REQUIRED: QQ 登录已失效', '历史消息接口返回错误（-3000）', '数据库写入失败：磁盘已满', '授权已到期', '下载更新失败：HTTP 503']) {
  assert.equal(qqSourceNotice(message), null);
  assert.equal(qqProgressNotice({ status: 'error', message, pages: 0, saved: 0 }), null);
}
assert.match(diagnosticError('QQ_LOGIN_REQUIRED: 登录失效，之前 HTTP 501'), /重新登录/);
assert.match(describeError('数据库写入失败'), /本地数据读取失败/);
assert.match(describeLicenseError('ACCOUNT_EXPIRED: 到期'), /授权已到期/);
assert.equal(qqProgressNotice({ status: 'running', message: 'QQ_SOURCE_BUSY: retrying', pages: 2, saved: 9 }), null);
console.log('QQ source notice checks passed: technical restrictions stay out of user feedback; authentication, data and completeness remain visible.');
