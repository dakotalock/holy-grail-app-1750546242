// netlify/functions/greeter.js

const sqlite3 = require('sqlite3').verbose(); // Import the sqlite3 library for database interaction
const path = require('path');                 // Node.js path module for path manipulation
const fs = require('fs');                     // Node.js file system module for checking directory existence

// Define the path for the SQLite database file.
// In Netlify Functions, the /tmp directory is the only writable location for ephemeral data.
const DB_PATH = path.join('/tmp', 'greeter.db');

/**
 * Initializes the SQLite database:
 * - Ensures the /tmp directory exists.
 * - Opens a connection to the database (creates the file if it doesn't exist).
 * - Creates the 'settings' table if it doesn't exist.
 * - Inserts the initial 'name_suffix' data if it's not present.
 *
 * This function runs on every invocation of the Netlify Function.
 * It's fast if the DB file and schema already exist for the current execution environment.
 *
 * @returns {Promise<void>} A promise that resolves when the database is initialized, or rejects on error.
 */
async function initDb() {
    return new Promise((resolve, reject) => {
        // Ensure the /tmp directory exists. This is generally true in Netlify, but good practice.
        if (!fs.existsSync('/tmp')) {
            fs.mkdirSync('/tmp');
        }

        // Open a database connection. sqlite3.Database will create the file if it doesn't exist.
        const db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('Database connection error:', err.message);
                return reject({
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Failed to connect to database.' })
                });
            }
            console.log('Connected to SQLite database at:', DB_PATH);
        });

        // Use db.serialize() to ensure commands run sequentially.
        db.serialize(() => {
            // Create the 'settings' table if it doesn't already exist.
            db.run(`CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE,
                value TEXT
            )`, (err) => {
                if (err) {
                    console.error('Error creating table:', err.message);
                    db.close(); // Close DB on error
                    return reject({
                        statusCode: 500,
                        body: JSON.stringify({ error: 'Failed to create settings table.' })
                    });
                }
                console.log('Settings table ensured.');
            });

            // Check if the initial 'name_suffix' entry exists.
            db.get("SELECT COUNT(*) as count FROM settings WHERE key = 'name_suffix'", (err, row) => {
                if (err) {
                    console.error('Error checking initial data:', err.message);
                    db.close();
                    return reject({
                        statusCode: 500,
                        body: JSON.stringify({ error: 'Failed to check initial data.' })
                    });
                }

                // If 'name_suffix' does not exist, insert it with 'World' as default.
                if (row.count === 0) {
                    db.run("INSERT INTO settings (key, value) VALUES (?, ?)", ['name_suffix', 'World'], (err) => {
                        if (err) {
                            console.error('Error inserting initial data:', err.message);
                            db.close();
                            return reject({
                                statusCode: 500,
                                body: JSON.stringify({ error: 'Failed to insert initial data.' })
                            });
                        }
                        console.log('Initial "name_suffix" data inserted.');
                        db.close((closeErr) => { // Close connection after operations
                            if (closeErr) console.error('Error closing db after init:', closeErr.message);
                            resolve();
                        });
                    });
                } else {
                    console.log('Initial "name_suffix" data already exists.');
                    db.close((closeErr) => { // Close connection
                        if (closeErr) console.error('Error closing db after init:', closeErr.message);
                        resolve();
                    });
                }
            });
        });
    });
}

/**
 * Helper function to open a new database connection.
 * Each request opens and closes its own connection for robustness in serverless.
 * @returns {sqlite3.Database} An opened SQLite database object.
 */
function openDb() {
    return new sqlite3.Database(DB_PATH);
}

/**
 * Handles the GET /api/greeting endpoint.
 * Retrieves the current name_suffix from the database and constructs the greeting message.
 * @returns {Promise<object>} A promise resolving to a Netlify Function response object.
 */
async function getGreeting() {
    return new Promise((resolve, reject) => {
        const db = openDb(); // Open a new database connection
        db.get("SELECT value FROM settings WHERE key = 'name_suffix'", (err, row) => {
            db.close(); // Always close the database connection after the query
            if (err) {
                console.error('Error retrieving name_suffix:', err.message);
                return reject({
                    statusCode: 500,
                    body: JSON.stringify({ error: 'Failed to retrieve greeting.' })
                });
            }
            // Use the fetched value or fallback to 'World' if not found
            const nameSuffix = row ? row.value : 'World';
            resolve({
                statusCode: 200,
                body: JSON.stringify({ message: `Hello, ${nameSuffix}!` })
            });
        });
    });
}

/**
 * Handles the POST /api/name endpoint.
 * Updates the 'name_suffix' in the database with the provided name from the request body.
 * @param {string} body - The raw request body (expected to be JSON).
 * @returns {Promise<object>} A promise resolving to a Netlify Function response object.
 */
async function updateName(body) {
    let name;
    try {
        // Parse the JSON request body
        const parsedBody = JSON.parse(body);
        name = parsedBody.name;
    } catch (e) {
        console.error('Error parsing request body:', e.message);
        return Promise.reject({
            statusCode: 400,
            body: JSON.stringify({ status: 'error', message: "Invalid input. Request body must be valid JSON." })
        });
    }

    // Validate the 'name' field
    if (!name || typeof name !== 'string') {
        return Promise.reject({
            statusCode: 400,
            body: JSON.stringify({ status: 'error', message: "Invalid input. 'name' field is required and must be a string." })
        });
    }

    return new Promise((resolve, reject) => {
        const db = openDb(); // Open a new database connection
        // Update the 'name_suffix' in the settings table
        db.run("UPDATE settings SET value = ? WHERE key = 'name_suffix'", [name], function (err) {
            db.close(); // Always close the database connection
            if (err) {
                console.error('Error updating name_suffix:', err.message);
                return reject({
                    statusCode: 500,
                    body: JSON.stringify({ status: 'error', message: "Failed to update name suffix." })
                });
            }
            // Check if any row was actually updated (this.changes is for the last run)
            if (this.changes === 0) {
                // This case should ideally not happen if initDb ensures the key exists.
                // But good for robustness if the key was somehow deleted.
                return reject({
                    statusCode: 500, // Or 404 if "name_suffix" wasn't found
                    body: JSON.stringify({ status: 'error', message: "Name suffix key not found for update." })
                });
            }
            resolve({
                statusCode: 200,
                body: JSON.stringify({ status: 'success', message: `Name suffix updated to ${name}.` })
            });
        });
    });
}

/**
 * Main Netlify Function handler.
 * This function acts as the entry point for all API requests routed to it.
 * It handles routing based on HTTP method and path, and manages database initialization
 * and CORS headers.
 *
 * @param {object} event - The event object from Netlify, containing request details.
 * @param {object} context - The context object from Netlify, containing environment info.
 * @returns {Promise<object>} A promise resolving to a Netlify Function response object.
 */
exports.handler = async (event, context) => {
    // IMPORTANT: As noted, SQLite data in /tmp is ephemeral in serverless environments.
    // This setup demonstrates database interaction but does not provide persistent storage
    // across different function invocations on Netlify.
    // For true persistence, consider an external database service.

    // Initialize the database for this specific function invocation.
    // This ensures the DB file and schema are ready.
    try {
        await initDb();
    } catch (errorResponse) {
        // If initDb fails, return the error immediately.
        return errorResponse;
    }

    const { path, httpMethod, body } = event;

    // Define CORS headers to allow cross-origin requests.
    // '*' is used for simplicity in this demonstration. For production, specify allowed origins.
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle OPTIONS preflight requests for CORS.
    // Browsers send an OPTIONS request before actual GET/POST requests to check permissions.
    if (httpMethod === 'OPTIONS') {
        return {
            statusCode: 204, // 204 No Content is standard for successful OPTIONS requests
            headers: headers,
            body: '' // No body needed for OPTIONS
        };
    }

    // Route requests based on path and HTTP method.
    // Netlify Functions paths include '/.netlify/functions/<function-name>/' prefix.
    if (path.includes('/.netlify/functions/greeter/api/greeting') && httpMethod === 'GET') {
        // Handle GET /api/greeting request
        return await getGreeting()
            .then(response => ({ ...response, headers })) // Add CORS headers to success response
            .catch(errorResponse => ({ ...errorResponse, headers })); // Add CORS headers to error response
    } else if (path.includes('/.netlify/functions/greeter/api/name') && httpMethod === 'POST') {
        // Handle POST /api/name request
        return await updateName(body)
            .then(response => ({ ...response, headers }))
            .catch(errorResponse => ({ ...errorResponse, headers }));
    } else {
        // Handle unknown routes or methods
        return {
            statusCode: 404,
            headers: headers,
            body: JSON.stringify({ error: 'Not Found' })
        };
    }
};