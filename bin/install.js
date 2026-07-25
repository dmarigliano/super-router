#!/usr/bin/env node

/**
 * Super Router Installer
 * Installs super-router skill into Claude Code
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude');
const SKILLS_DIR = path.join(CLAUDE_CONFIG_DIR, 'skills', 'super-router');

async function install() {
  console.log('📦 Installing Super Router...');

  // Create skills directory
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    console.log(`✓ Created ${SKILLS_DIR}`);
  }

  // Copy skill files
  const sourceDir = path.join(__dirname, '..', 'skills');
  const files = [
    'SKILL.md',
    'README.md',
    'classifier.ts',
    'agent-router.ts',
    'skill-router.ts',
    'orchestrator.ts',
    'logger.ts',
    'index.ts',
    'config.json',
  ];

  for (const file of files) {
    const src = path.join(sourceDir, file);
    const dest = path.join(SKILLS_DIR, file);

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`✓ Installed ${file}`);
    }
  }

  // Make index.ts executable
  try {
    fs.chmodSync(path.join(SKILLS_DIR, 'index.ts'), 0o755);
  } catch (e) {
    // Windows doesn't support chmod, ignore
  }

  console.log('\n✅ Super Router installed successfully!');
  console.log('\nUsage:');
  console.log('  /super-router "your task description"');
  console.log('  ~/.bun/bin/bun ~/.claude/skills/super-router/index.ts "task"');
  console.log('  ~/.bun/bin/bun ~/.claude/skills/super-router/index.ts --stats');
  console.log('  ~/.bun/bin/bun ~/.claude/skills/super-router/index.ts --savings');
}

async function uninstall() {
  console.log('🗑  Uninstalling Super Router...');

  if (fs.existsSync(SKILLS_DIR)) {
    fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
    console.log(`✓ Removed ${SKILLS_DIR}`);
  }

  // Remove log files
  const logFile = path.join(CLAUDE_CONFIG_DIR, 'super-router.log');
  const savingsFile = path.join(CLAUDE_CONFIG_DIR, 'super-router-savings.jsonl');

  if (fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
    console.log('✓ Removed logs');
  }

  if (fs.existsSync(savingsFile)) {
    fs.unlinkSync(savingsFile);
    console.log('✓ Removed savings data');
  }

  console.log('\n✅ Super Router uninstalled');
}

// CLI
const args = process.argv.slice(2);

if (args.includes('--uninstall')) {
  uninstall().catch((err) => {
    console.error('❌ Uninstall failed:', err.message);
    process.exit(1);
  });
} else {
  install().catch((err) => {
    console.error('❌ Install failed:', err.message);
    process.exit(1);
  });
}
