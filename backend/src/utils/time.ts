/**
 * PSO-8601 time formatting.
 *
 * Jeffery's preferred datetime format. Human-readable, consistent.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Return current date in PSO-8601 format: Wed Dec 31 2025
 */
export function pso8601Date(): string {
  const now = new Date();
  const day = DAYS[now.getDay()];
  const month = MONTHS[now.getMonth()];
  const date = String(now.getDate()).padStart(2, '0');
  const year = now.getFullYear();
  return `${day} ${month} ${date} ${year}`;
}

/**
 * Return current time in PSO-8601 format: 4:23 PM (no leading zero)
 */
export function pso8601Time(): string {
  const now = new Date();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 -> 12
  return `${hours}:${minutes} ${ampm}`;
}

/**
 * Return full datetime in PSO-8601 format: Wed Dec 31 2025, 4:23 PM
 */
export function pso8601DateTime(): string {
  return `${pso8601Date()}, ${pso8601Time()}`;
}
