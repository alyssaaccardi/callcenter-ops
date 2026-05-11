import axios from 'axios';

const api = axios.create({
  baseURL: '',
  withCredentials: true,
  timeout: 60000,
});

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401 && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
