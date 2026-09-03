const fs = require('fs');
const path = require('path');

const baseUrl = 'https://dividendhub.site';
const pages = [
  { url: '/', priority: 1.0 },
  { url: '/top', priority: 0.9 },
  { url: '/portfolio', priority: 0.8 },
];

let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
pages.forEach(p => {
  xml += `  <url>\n`;
  xml += `    <loc>${baseUrl}${p.url}</loc>\n`;
  xml += `    <changefreq>daily</changefreq>\n`;
  xml += `    <priority>${p.priority}</priority>\n`;
  xml += `  </url>\n`;
});
xml += `</urlset>`;

const outputPath = path.join(__dirname, '../public/sitemap.xml');
fs.writeFileSync(outputPath, xml);
console.log(`✅ Sitemap generated at ${outputPath}`);