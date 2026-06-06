module.exports = {
  apps: [{
    name:          'mitel-poller',
    script:        'mitel-queue-poller.js',
    watch:         false,
    restart_delay: 5000,
    max_restarts:  20,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
