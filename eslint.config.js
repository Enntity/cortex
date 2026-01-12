// ESLint Flat Config (v9+)
// Note: For import rules to work, install: npm install -D eslint-plugin-import eslint-import-resolver-node

export default [
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                // Browser globals
                window: 'readonly',
                document: 'readonly',
                navigator: 'readonly',
                // Node.js globals
                process: 'readonly',
                Buffer: 'readonly',
                global: 'readonly',
                console: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-useless-escape': 'off',
        },
    },
    {
        ignores: [
            // Build artifacts
            'dist/**',
            'build/**',
            // Dependencies
            'node_modules/**',
            // Log files
            '*.log',
            // Config files
            '.env',
            '.env.*',
            // Coverage
            'coverage/**',
            // Helper apps
            'helper-apps/**',
            // Documentation
            'docs/**',
            // Tests
            'tests/**',
            // Generated files
            '*.min.js',
            '*.bundle.js',
            // IDE files
            '.idea/**',
            '.vscode/**',
            '*.sublime-*',
            '*.iml',
            '*.swp',
        ],
    },
];