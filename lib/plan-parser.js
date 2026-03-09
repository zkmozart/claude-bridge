'use strict';

const matter = require('gray-matter');
const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true });

/**
 * Schema for team plan frontmatter.
 * Required fields: id, title, created, created_by, priority, branch, team
 */
const planSchema = {
    type: 'object',
    required: ['id', 'title', 'created', 'created_by', 'priority', 'branch', 'team'],
    properties: {
        id: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        created: { type: 'string' },
        created_by: { type: 'string' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        branch: { type: 'string', minLength: 1 },
        team: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['agent', 'scope'],
                properties: {
                    agent: { type: 'string' },
                    scope: { type: 'array', items: { type: 'string' } },
                    blocked_files: { type: 'array', items: { type: 'string' } },
                    depends_on: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        max_turns_per_agent: { type: 'integer', minimum: 1 },
        max_budget_usd: { type: 'number', minimum: 0 },
        tags: { type: 'array', items: { type: 'string' } },
    },
};

const validate = ajv.compile(planSchema);

/**
 * Parse a team plan markdown file with YAML frontmatter.
 * @param {string} content - Raw file content (markdown with YAML frontmatter)
 * @returns {{ frontmatter: Object, body: string }}
 */
function parsePlan(content) {
    try {
        const { data, content: body } = matter(content);
        return { frontmatter: data, body: body.trim() };
    } catch (err) {
        // YAML parse failure (e.g., unescaped braces in strings)
        return { frontmatter: {}, body: content, parseError: err.message };
    }
}

/**
 * Validate plan frontmatter against schema.
 * @param {Object} frontmatter
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validatePlan(frontmatter) {
    const valid = validate(frontmatter);
    if (valid) {
        return { valid: true, errors: [] };
    }
    const errors = validate.errors.map(
        (e) => `${e.instancePath || '/'}: ${e.message}`
    );
    return { valid: false, errors };
}

module.exports = { parsePlan, validatePlan };
