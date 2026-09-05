// A pipe can accept a write asynchronously. Delay it so a forced exit loses
// the completion text on every operating system, independent of pipe size.
const write = process.stdout.write.bind(process.stdout);

process.stdout.write = (chunk, encoding, callback) => {
  setTimeout(() => write(chunk, encoding, callback), 25);
  return false;
};
