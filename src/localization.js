'use strict';

let locale = 'en';
let resources = {};

function normalizeLocale(language) {
  const value = String(language || '').trim().replace(/_/g, '-').toLowerCase();
  if (value === 'zh-tw' || value.startsWith('zh-tw-') || value === 'zh-hant' || value.startsWith('zh-hant-') || value === 'zh-hk' || value === 'zh-mo' || value.startsWith('zh-hk-') || value.startsWith('zh-mo-')) return 'zh-tw';
  if (value === 'zh' || value === 'zh-cn' || value === 'zh-hans' || value.startsWith('zh-hans-') || value.startsWith('zh-cn-') || value === 'zh-sg' || value.startsWith('zh-sg-')) return 'zh-cn';
  if (value === 'ja' || value.startsWith('ja-')) return 'ja';
  if (value === 'ko' || value.startsWith('ko-')) return 'ko';
  return 'en';
}

function setLocale(language, preference = 'auto') {
  const selected = ['en', 'zh-cn', 'zh-tw', 'ja', 'ko'].includes(preference) ? preference : 'auto';
  locale = selected === 'auto' ? normalizeLocale(language) : selected;
  resources = locale === 'en' ? {} : require(`../package.nls.${locale}.json`);
  return locale;
}

function t(source, values) {
  let result = Object.hasOwn(resources, source) ? resources[source] : source;
  if (Array.isArray(values)) result = result.replace(/\{(\d+)\}/g, (match, index) => values[Number(index)] === undefined ? match : String(values[Number(index)]));
  return result;
}

function retranslate(text) {
  if (typeof text !== 'string') return text;
  const dictionaries = ['zh-cn', 'zh-tw', 'ja', 'ko'].map(language => require(`../package.nls.${language}.json`));
  // Status reasons created in English already equal their source key.
  if (dictionaries.some(dictionary => Object.hasOwn(dictionary, text) && !text.startsWith('manifest.'))) return t(text);
  // Reasons created in another locale can be mapped back to their exact source key.
  for (const dictionary of dictionaries) {
    const source = Object.keys(dictionary).find(key => !key.startsWith('manifest.') && dictionary[key] === text);
    if (source) return t(source);
  }
  // Unknown and dynamic messages (for example, OS errors containing paths) remain intact.
  return text;
}

function getLocale() { return locale; }
module.exports = { normalizeLocale, setLocale, getLocale, t, retranslate };
