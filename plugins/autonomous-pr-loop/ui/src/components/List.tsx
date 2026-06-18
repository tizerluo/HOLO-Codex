import type { JSX } from "react";
import type { EffectiveLocale } from "../../../core/locale.js";
import { t } from "../i18n.js";

export function List({ items, locale }: { items: string[]; locale: EffectiveLocale }): JSX.Element {
  return <ul className="plain-list">{items.length === 0 ? <li>{t(locale, "noneList")}</li> : items.map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}</ul>;
}
