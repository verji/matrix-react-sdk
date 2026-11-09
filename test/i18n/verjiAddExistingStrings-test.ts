/*
Copyright 2026 Verji Tech AS

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import en from "../../src/i18n/strings/en_EN.json";
import nb from "../../src/i18n/strings/nb_NO.json";

/** The placeholders `_t` fills in a string: `%(name)s` and `<tag>`, in order of name. */
const placeholders = (text: string): string[] =>
    Array.from(text.matchAll(/%\(\w+\)s|<\/?\w+\s*\/?>/g), (match) => match[0]).sort();

// VERJI: verji/verji-src#2117 — the add-existing dialogs and options are shown in Norwegian too.
describe("the Verji add-existing strings", () => {
    const english: Record<string, string> = en.verji.add_existing;
    const norwegian: Record<string, string | undefined> = nb.verji.add_existing;

    it.each(Object.keys(english))("has verji|add_existing|%s in Norwegian, with the same placeholders", (key) => {
        const text = norwegian[key];
        expect(text).toEqual(expect.any(String));
        expect(placeholders(text!)).toEqual(placeholders(english[key]));
    });
});
