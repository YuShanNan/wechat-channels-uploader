const fs = require('fs');
const path = require('path');

const lines = fs.readFileSync(path.join(__dirname, 'all-videos.txt'), 'utf-8')
  .split('\n')
  .filter(line => line.trim());

const rows = [];

for (const fullPath of lines) {
  // Parse path: E:\推文\视频号\{drama}\{subdir}\{filename}.mp4
  // Title: {drama} - {filename without ext}
  // Short drama: extract from folder name

  const relative = path.relative('E:\\推文\\视频号', fullPath);
  const parts = relative.split(path.sep);
  const dramaName = parts[0]; // top-level drama folder
  const filename = path.basename(fullPath, '.mp4');

  // Generate title: drama name + filename
  const title = `${dramaName} - ${filename}`;

  // Description template
  const description = `#${dramaName} #短剧`;

  rows.push({
    video_path: fullPath,
    title,
    description,
    short_drama_name: dramaName,
    publish_time: '', // user fills in
    cover_path: '',   // user fills in
  });
}

// Write CSV
const header = 'video_path,title,description,short_drama_name,publish_time,cover_path';
const csvLines = [header];
for (const row of rows) {
  csvLines.push(`"${row.video_path}","${row.title}","${row.description}","${row.short_drama_name}","${row.publish_time}","${row.cover_path}"`);
}

const csvPath = path.join(__dirname, 'batch-config.csv');
fs.writeFileSync(csvPath, '﻿' + csvLines.join('\n'), 'utf-8'); // BOM for Excel
console.log(`Generated ${rows.length} rows to ${csvPath}`);

// Also print summary by drama
const byDrama = {};
for (const row of rows) {
  byDrama[row.short_drama_name] = (byDrama[row.short_drama_name] || 0) + 1;
}
console.log('\nBy drama:');
for (const [name, count] of Object.entries(byDrama).sort()) {
  console.log(`  ${name}: ${count} videos`);
}
