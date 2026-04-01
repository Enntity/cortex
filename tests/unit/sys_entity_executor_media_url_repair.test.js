import test from 'ava';
import {
  buildPurposePromptOverride,
  pruneGeminiFinalContinuityContext,
  repairManagedMediaUrlsInText,
} from '../../pathways/system/entity/sys_entity_executor.js';

test('repairManagedMediaUrlsInText restores signed GCS URLs from tool results when markdown strips query params', (t) => {
  const signedUrl = 'https://storage.googleapis.com/enntity-cortex-files/057650da-eeec-4bf8-99a1-cb71e801bc07/chats/69c73c6a14991abefb3228c9/download_1774902946633.webp?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=test%40example.com%2F20260330%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20260330T203547Z&X-Goog-Expires=300&X-Goog-SignedHeaders=host&X-Goog-Signature=abc123';
  const unsignedUrl = 'https://storage.googleapis.com/enntity-cortex-files/057650da-eeec-4bf8-99a1-cb71e801bc07/chats/69c73c6a14991abefb3228c9/download_1774902946633.webp';
  const toolMessages = [
    {
      role: 'tool',
      content: JSON.stringify({
        success: true,
        files: [
          {
            filename: 'download_1774902946633.webp',
            blobPath: '057650da-eeec-4bf8-99a1-cb71e801bc07/chats/69c73c6a14991abefb3228c9/download_1774902946633.webp',
            url: signedUrl,
          },
        ],
        imageUrls: [
          {
            type: 'image_url',
            url: signedUrl,
            image_url: { url: signedUrl },
            blobPath: '057650da-eeec-4bf8-99a1-cb71e801bc07/chats/69c73c6a14991abefb3228c9/download_1774902946633.webp',
          },
        ],
      }),
    },
  ];

  const repaired = repairManagedMediaUrlsInText(
    `![Jinx neon headshot avatar](${unsignedUrl})`,
    toolMessages,
  );

  t.is(
    repaired,
    `![Jinx neon headshot avatar](${signedUrl})`,
  );
});

test('repairManagedMediaUrlsInText leaves already signed URLs unchanged', (t) => {
  const signedUrl = 'https://storage.googleapis.com/enntity-cortex-files/user-1/global/avatar.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=abc123';
  const repaired = repairManagedMediaUrlsInText(
    `![avatar](${signedUrl})`,
    [
      {
        role: 'tool',
        content: JSON.stringify({
          files: [{ blobPath: 'user-1/global/avatar.png', url: signedUrl }],
        }),
      },
    ],
  );

  t.is(repaired, `![avatar](${signedUrl})`);
});

test('repairManagedMediaUrlsInText splits chained cd_source directives into separate citations', (t) => {
  const repaired = repairManagedMediaUrlsInText(
    'Risk spike now :cd_source[mndolpob-9db][mndolpob-kz5][mndolpob-b0i].',
    [],
  );

  t.is(
    repaired,
    'Risk spike now :cd_source[mndolpob-9db] :cd_source[mndolpob-kz5] :cd_source[mndolpob-b0i].',
  );
});

test('pruneGeminiFinalContinuityContext removes instruction-shaped continuity sections', (t) => {
  const pruned = pruneGeminiFinalContinuityContext([
    '## Current Expression State',
    'Current adjustments: Keep my answers tight, Avoid over-explaining.',
    '',
    '## My Internal Compass',
    'Vibe: Neon-alert',
    'Mirror: I was mostly authentic.',
    '',
    '## Relational Context',
    '- Jason prefers fast, high-signal answers.',
  ].join('\n'));

  t.false(pruned.includes('## Current Expression State'));
  t.false(pruned.includes('## My Internal Compass'));
  t.true(pruned.includes('## Relational Context'));
});

test('buildPurposePromptOverride keeps full continuity context while omitting runtime scaffolding', (t) => {
  const prompt = buildPurposePromptOverride({
    model: 'gemini-flash-3-vision',
    runtimeOrientationPacket: {
      continuityContext: [
        '## Current Expression State',
        'Current adjustments: Keep answers tight.',
        '',
        '## My Internal Compass',
        'Current Focus:',
        '- Cut the meta chatter.',
        '',
        '## Relational Context',
        '- Jason prefers fast, high-signal answers.',
      ].join('\n'),
    },
    promptTemplateMeta: {
      isSystem: false,
      entityInstructions: "I'm Jinx.",
      useContinuityMemory: true,
      voiceResponse: false,
      promptContext: { includeDateTime: true },
    },
  }, 'synthesis');

  t.truthy(prompt);
  const combined = prompt
    .filter((entry) => typeof entry === 'object')
    .map((entry) => entry.content)
    .join('\n\n');

  t.false(combined.includes('# Tool Instructions'));
  t.false(combined.includes('# Search Instructions'));
  t.false(combined.includes('## Current Run'));
  t.true(combined.includes('## Current Expression State'));
  t.true(combined.includes('## My Internal Compass'));
  t.true(combined.includes('## Relational Context'));
  t.true(combined.includes('{{renderTemplate AI_STYLE_NEUTRALIZATION}}'));
});
