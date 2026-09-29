const fs = require('fs');
let c = fs.readFileSync('public/app/index.html', 'utf8');

c = c.replace(/<select id="admin-qbank-country-input"[\s\S]*?<\/select>\n\s*<select id="admin-qbank-country-input"[\s\S]*?<\/select>/, '');

const newSelect = `<select id="admin-qbank-country-input" class="login-input" style="width:140px; cursor:pointer;">
                                    <option value="global">🌍 Global</option>
                                    <option value="usa">🇺🇸 USA</option>
                                    <option value="uk">🇬🇧 UK</option>
                                    <option value="australia">🇦🇺 Australia</option>
                                    <option value="canada">🇨🇦 Canada</option>
                                    <option value="india">🇮🇳 India</option>
                                    <option value="europe">🇪🇺 Europe</option>
                                    <option value="tunisia">🇹🇳 Tunisia</option>
                                    <option value="algeria">🇩🇿 Algeria</option>
                                    <option value="egypt">🇪🇬 Egypt</option>
                                </select>`;

c = c.replace(/<select id="admin-qbank-country-input"[\s\S]*?<\/select>/, newSelect);

fs.writeFileSync('public/app/index.html', c, 'utf8');
