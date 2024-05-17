const path = require("path");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const express = require("express");
const session = require("express-session");
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: "some secret",
    cookie: { maxAge: 3600000 },
    resave: false,
    saveUninitialized: false,
  })
);

const db = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "",
  database: "own_finance",
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/static", express.static(path.join(__dirname, "static")));

// Login route--------------------------------------------------------------------------------------------------------------------
app.get("/login", (req, res) => {
  res.render("login", { error_message: req.session.error_message });
  delete req.session.error_message; // Очистить сообщение об ошибке
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const [users] = await db.query(
      "SELECT * FROM Users WHERE username = ? OR email = ?",
      [username, username]
    );
    if (users.length === 0) {
      req.session.error_message = "User not found.";
      return res.redirect("/login");
    }
    const user = users[0];
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      req.session.error_message = "Incorrect password.";
      return res.redirect("/login");
    }
    // Установить переменные сессии для пользователя
    req.session.user_id = user.user_id;
    req.session.username = user.username;
    return res.redirect("/dashboard");
  } catch (error) {
    console.error("Login error:", error.message);
    req.session.error_message = "An error occurred during login.";
    res.redirect("/login");
  }
});

// Registration route------------------------------------------------------------------------------------------------------------------
app.get("/register", (req, res) => {
  res.render("register", {
    form_data: req.session.form_data || {},
    error_message: req.session.error_message,
    success_message: req.session.success_message,
  });
  // Очистить сообщения из сессии
  delete req.session.error_message;
  delete req.session.success_message;
  delete req.session.form_data;
});

app.post("/register", async (req, res) => {
  const {
    name,
    surname,
    midname,
    username,
    email,
    password,
    confirm_password,
  } = req.body;

  if (password !== confirm_password) {
    req.session.error_message = "Passwords do not match.";
    return res.redirect("/register");
  }

  try {
    // Проверить уникальность username и почты
    const [usersByUsername] = await db.query(
      "SELECT * FROM Users WHERE username = ?",
      [username]
    );
    const [usersByEmail] = await db.query(
      "SELECT * FROM Users WHERE email = ?",
      [email]
    );

    if (usersByUsername.length > 0) {
      req.session.error_message = "Username already exists.";
      return res.redirect("/register");
    }

    if (usersByEmail.length > 0) {
      req.session.error_message = "Email already exists.";
      return res.redirect("/register");
    }

    // Захешировать пароль и записать пользователя в базу данных
    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query(
      "INSERT INTO Users (name, surname, midname, username, email, password) VALUES (?, ?, ?, ?, ?, ?)",
      [name, surname, midname, username, email, hashedPassword]
    );

    req.session.success_message = "Registration successful!";
    res.redirect("/login");
  } catch (error) {
    console.error("Registration error:", error.message);
    req.session.error_message = "An error occurred during registration.";
    res.redirect("/register");
  }
});

// Функция для проверки аутентификации
const isAuthenticated = (req, res, next) => {
  if (!req.session.user_id) {
    return res.redirect("/login");
  }
  next();
};

// Защищенные руты
app.get("/", isAuthenticated, (req, res) => {
  res.render("index", {});
});

// Вспомогательная функция для получения категорий доходов из бд
async function getIncomeCategories(userId) {
  const [rows] = await db.query(
    'SELECT name FROM categories WHERE user_id = ? AND type = "income"',
    [userId]
  );
  return rows.map((row) => row.name);
}

// Перевод периодов
function translatePeriod(period) {
  const periodTranslations = {
    today: "Сегодня",
    week: "Неделя",
    month: "Месяц",
    all_time: "За все время",
  };
  return periodTranslations[period] || period;
}

// Вспомогательная функция для получения категорий расходов из бд
async function getExpenseCategories(userId) {
  const [rows] = await db.query(
    'SELECT name FROM categories WHERE user_id = ? AND type = "expense"',
    [userId]
  );
  return rows.map((row) => row.name);
}

// Вспомогательная функция для получения последних транзакций
async function getRecentTransactions(userId) {
  const [rows] = await db.query(
    "SELECT t.amount, t.description, t.date, c.name AS category_name, t.type " +
      "FROM transactions t " +
      "JOIN categories c ON t.category_id = c.category_id " +
      "WHERE t.user_id = ? " +
      "ORDER BY t.date DESC LIMIT 10",
    [userId]
  );
  return rows;
}

// Вспомогательная функция для получения сводки суммы доходов и расходов
async function getSummary(userId, startDate, endDate) {
  const [incomeRows] = await db.query(
    "SELECT SUM(amount) AS total_income " +
      "FROM transactions " +
      'WHERE user_id = ? AND type = "income" AND date BETWEEN ? AND ?',
    [userId, startDate, endDate]
  );
  const [expenseRows] = await db.query(
    "SELECT SUM(amount) AS total_expense " +
      "FROM transactions " +
      'WHERE user_id = ? AND type = "expense" AND date BETWEEN ? AND ?',
    [userId, startDate, endDate]
  );

  const totalIncome = incomeRows[0].total_income || 0;
  const totalExpenses = expenseRows[0].total_expense || 0;

  return { totalIncome, totalExpenses };
}

// Вспомогательная функция для получения суммы транзакций по категориям
async function getCategorySummaryAndMax(userId, startDate, endDate) {
  const [categories] = await db.query(
    `
    SELECT DISTINCT c.category_id, c.name
    FROM categories c
    JOIN transactions t ON c.category_id = t.category_id
    WHERE c.user_id = ? AND t.date BETWEEN ? AND ?`,
    [userId, startDate, endDate]
  );
  let categorySummary = {};
  let maxCategory = { name: "", amount: 0 };

  for (const category of categories) {
    const [result] = await db.query(
      `
      SELECT SUM(amount) AS total_amount
      FROM transactions
      WHERE user_id = ? AND category_id = ? AND date BETWEEN ? AND ?`,
      [userId, category.category_id, startDate, endDate]
    );
    const totalAmount = result[0].total_amount;
    categorySummary[category.name] = totalAmount;

    // Проверить если это категория имеет максимальную сумму
    if (totalAmount > maxCategory.amount) {
      maxCategory.name = category.name;
      maxCategory.amount = totalAmount;
    }
  }

  return { categorySummary, maxCategory };
}

// Вспомогательная функция для расчетна начальной и конечной дат на основе периода
function getPeriodDates(period, customStartDate, customEndDate) {
  let startDate, endDate;
  const today = new Date();
  switch (period) {
    case "today":
      startDate = endDate = today.toISOString().split("T")[0];
      console.log("today - " + startDate);
      break;
    case "week":
      const weekStart = new Date(
        today.setDate(today.getDate() - today.getDay() + 1)
      );
      const weekEnd = new Date(
        today.setDate(today.getDate() - today.getDay() + 7)
      );
      startDate = weekStart.toISOString().split("T")[0];
      endDate = weekEnd.toISOString().split("T")[0];
      break;
    case "month":
      startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split("T")[0];
      endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split("T")[0];
      break;
    case "all_time":
      startDate = "1970-01-01";
      endDate = today.toISOString().split("T")[0];
      break;
    case "custom":
      startDate = customStartDate;
      endDate = customEndDate;
      break;
    default:
      startDate = endDate = today.toISOString().split("T")[0];
      break;
  }
  return { startDate, endDate };
}

// Dashboard route-------------------------------------------------------------------------------------------------------------------
app.get("/dashboard", isAuthenticated, async (req, res) => {
  const userId = req.session.user_id;
  const username = req.session.username;
  const title = "Ваша сводка";
  try {
    const incomeCategories = await getIncomeCategories(userId);
    const expenseCategories = await getExpenseCategories(userId);
    const recentTransactions = await getRecentTransactions(userId);
    const period = req.query.period || "today"; // Выбранный период
    // Получение дат на основе кастомного периода
    const customStartDate = req.query.start_date;
    const customEndDate = req.query.end_date;
    const { startDate, endDate } = getPeriodDates(
      period,
      customStartDate,
      customEndDate
    );

    const { totalIncome, totalExpenses } = await getSummary(
      userId,
      startDate,
      endDate
    ); // Подсчет суммы доходов и расходов
    const addTransaction = false;

    const { totalIncome: totalIncomes, totalExpenses: totalExpensesAll } =
      await getSummary(
        userId,
        "1970-01-01",
        new Date().toISOString().split("T")[0]
      ); // Подсчет суммы доходов и расходов за все время

    res.render("dashboard", {
      title,
      username,
      incomeCategories,
      expenseCategories,
      recentTransactions,
      totalIncome,
      totalExpense: totalExpenses,
      totalIncomes: totalIncomes,
      totalExpenses: totalExpensesAll,
      period,
      startDate,
      endDate,
      translatePeriod: translatePeriod,
      addTransaction: addTransaction,
    });
  } catch (error) {
    console.error("Error on the dashboard page:", error.message);
    res.status(500).send("Internal Server Error");
  }
});

// Рут для выбора периода
app.post("/dashboard/select-period", isAuthenticated, async (req, res) => {
  const { period } = req.body; // 'today', 'week', 'month', or 'all_time'
  res.redirect("/dashboard?period=" + period);
});

// Рут для выбора кастомного периода
app.post("/dashboard/custom-period", isAuthenticated, async (req, res) => {
  const { start_date, end_date } = req.body;
  res.redirect(
    `/dashboard?period=custom&start_date=${start_date}&end_date=${end_date}`
  );
});

// Рут для добавления новой транзакции
app.post("/dashboard/add-transaction", isAuthenticated, async (req, res) => {
  const userId = req.session.user_id;
  const { amount, description, date, type, category } = req.body;

  try {
    const [categoryRows] = await db.query(
      "SELECT category_id FROM categories WHERE user_id = ? AND name = ? AND type = ?",
      [userId, category, type]
    );
    if (categoryRows.length === 0) {
      throw new Error("Category not found.");
    }
    const category_id = categoryRows[0].category_id;

    // Вставить в бд новую транзакцию
    await db.query(
      "INSERT INTO transactions (user_id, category_id, amount, description, date, type) VALUES (?, ?, ?, ?, ?, ?)",
      [userId, category_id, amount, description, date, type]
    );

    // Сообщение об успешном добавлении транзакции
    req.session.success_message = "Transaction added successfully!";
    res.redirect("/dashboard");
  } catch (error) {
    console.error("Error adding transaction:", error.message);
    req.session.error_message =
      "An error occurred while adding the transaction.";
    res.redirect("/dashboard");
  }
});

// Categories route-----------------------------------------------------------------------------------------------------------------
app.get("/categories", isAuthenticated, async (req, res) => {
  const username = req.session.username;
  const title = "Управление категориями";
  try {
    const [incomeCategories] = await db.query(
      'SELECT * FROM categories WHERE user_id = ? AND type = "income"',
      [req.session.user_id]
    );
    const [expenseCategories] = await db.query(
      'SELECT * FROM categories WHERE user_id = ? AND type = "expense"',
      [req.session.user_id]
    );
    res.render("categories", {
      title,
      username,
      incomeCategories,
      expenseCategories,
    });
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).send("Error fetching categories");
  }
});

// Рут для добавления новой категории
app.post("/categories/add_category", isAuthenticated, async (req, res) => {
  const { new_category: newCategoryName, category_type: categoryType } =
    req.body;
  if (newCategoryName) {
    try {
      const [existingCategory] = await db.query(
        "SELECT * FROM categories WHERE user_id = ? AND name = ?",
        [req.session.user_id, newCategoryName]
      );
      if (existingCategory.length > 0) {
        console.log(
          "Category with this name already exists. Please choose a different name."
        );
      } else {
        await db.query(
          "INSERT INTO categories (user_id, name, type) VALUES (?, ?, ?)",
          [req.session.user_id, newCategoryName, categoryType]
        );
        res.redirect("/categories");
      }
    } catch (error) {
      console.error("Error adding category:", error);
      res.status(500).send("Error adding category");
    }
  } else {
    console.log("Category name cannot be empty.");
    res.redirect("/categories");
  }
});

// Рут для удаления категории
app.post("/delete_category", isAuthenticated, async (req, res) => {
  const { category_id: categoryId } = req.body;
  console.log(categoryId);
  if (categoryId) {
    try {
      await db.query(
        "DELETE FROM categories WHERE category_id = ? AND user_id = ?",
        [categoryId, req.session.user_id]
      );
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting category:", error);
      res.json({ success: false, error: "Error deleting category" });
    }
  } else {
    res.json({ success: false, error: "Category ID is required" });
  }
});

// Account route---------------------------------------------------------------------------------------------------------------
app.get("/account", isAuthenticated, async (req, res) => {
  const title = "Аккаунт";
  try {
    const [user_info] = await db.query(
      "SELECT * FROM users WHERE user_id = ?",
      [req.session.user_id]
    );
    if (user_info.length > 0) {
      res.render("account", {
        title,
        user: user_info[0],
        editing_mode: req.query.edit === "true",
        username: req.session.username,
        messages: req.session.messages,
      });
      delete req.session.messages;
    } else {
      throw new Error("User data not found");
    }
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

// Рут для обновления аккаунта
app.post("/update_account", isAuthenticated, async (req, res) => {
  const {
    new_name,
    new_surname,
    new_midname,
    new_username,
    new_email,
    new_password,
  } = req.body;
  const hashedPassword = await bcrypt.hash(new_password, 10); // Hash the new password

  try {
    await db.query(
      "UPDATE users SET name = ?, surname = ?, midname = ?, username = ?, email = ?, password = ? WHERE user_id = ?",
      [
        new_name,
        new_surname,
        new_midname,
        new_username,
        new_email,
        hashedPassword,
        req.session.user_id,
      ]
    );
    req.session.messages = {
      success: "Account information updated successfully.",
    };
    res.redirect("/account");
  } catch (error) {
    console.error("Error updating account:", error);
    req.session.messages = { error: "Error updating account information." };
    res.redirect("/account?edit=true");
  }
});

// Рут для выхода
app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
      req.session.messages = { error: "Error logging out." };
      res.redirect("/account");
    } else {
      res.clearCookie("some secret"); // The name of the cookie may vary based on your session configuration
      res.redirect("/login");
    }
  });
});

// History route-------------------------------------------------------------------------------------------------------------------
app.get("/history", isAuthenticated, async (req, res) => {
  const transactionsPerPage = parseInt(req.query.per_page, 10) || 10;
  const currentPage = parseInt(req.query.page, 10) || 1;

  try {
    // Вычислить общее количество транзакций
    const [[{ count }]] = await db.query(
      "SELECT COUNT(*) AS count FROM transactions WHERE user_id = ?",
      [req.session.user_id]
    );
    const totalTransactions = count;
    const totalPages = Math.ceil(totalTransactions / transactionsPerPage);

    // Получить список транзакций
    const [transactions] = await db.query(
      `SELECT t.*, c.name AS category_name
      FROM transactions t
      JOIN categories c ON t.category_id = c.category_id
      WHERE t.user_id = ?
      ORDER BY t.date DESC
      LIMIT ?, ?`,
      [
        req.session.user_id,
        transactionsPerPage * (currentPage - 1),
        transactionsPerPage,
      ]
    );

     // Группировать транзакции по месяцам
     const transactionsByMonth = {};
     transactions.forEach(transaction => {
       const month = new Date(transaction.date).toLocaleString('default', { month: 'long', year: 'numeric' });
       if (!transactionsByMonth[month]) {
         transactionsByMonth[month] = [];
       }
       transactionsByMonth[month].push(transaction);
     });

    res.render("history", {
      title: "Все транзакции",
      transactions,
      transactionsByMonth,
      totalPages,
      currentPage,
      transactionsPerPage,
      totalTransactions,
      username: req.session.username,
    });
  } catch (error) {
    console.error("Error fetching transaction history:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Рут для удаления транзакции
app.post("/history/delete_transaction", isAuthenticated, async (req, res) => {
  const { transaction_id } = req.body;

  try {
    // Удаленить транзакцию из базы данных
    await db.query(
      "DELETE FROM transactions WHERE transaction_id = ? AND user_id = ?",
      [transaction_id, req.session.user_id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting transaction:", error);
    res.json({ success: false, message: "Error deleting transaction" });
  }
});

// Statistics route---------------------------------------------------------------------------------------------------------------
app.get("/statistics", isAuthenticated, async (req, res) => {
  const userId = req.session.user_id;
  const period = req.query.period || "today";

  // Retrieve custom dates from query parameters if available
  const customStartDate = req.query.start_date;
  const customEndDate = req.query.end_date;
  const { startDate, endDate } = getPeriodDates(
    period,
    customStartDate,
    customEndDate
  );

  try {
    const recentTransactions = await getRecentTransactions(userId);
    const { totalIncome, totalExpenses } = await getSummary(
      userId,
      startDate,
      endDate
    );
    const { categorySummary, maxCategory } = await getCategorySummaryAndMax(
      userId,
      startDate,
      endDate
    );
    // Вычислить сумму доходов и расходов за все время
    const { totalIncome: totalIncomes, totalExpenses: totalExpensesAll } =
      await getSummary(
        userId,
        "1970-01-01",
        new Date().toISOString().split("T")[0]
      );

    res.render("statistics", {
      title: "Статистика",
      username: req.session.username,
      recentTransactions,
      totalIncome: totalIncome,
      totalExpense: totalExpenses,
      totalIncomes: totalIncomes,
      totalExpenses: totalExpensesAll,
      categorySummary,
      maxCategory,
      period: translatePeriod(period),
      startDate,
      endDate,
    });
  } catch (error) {
    console.error("Error on the statistics page:", error.message);
    res.status(500).send("Internal Server Error");
  }
});

// Рут для выбора периода
app.post("/statistics/select-period", isAuthenticated, async (req, res) => {
  const { period } = req.body; // 'today', 'week', 'month', or 'all_time'
  res.redirect("/statistics?period=" + period);
});

// Рут для выбора кастомного периода
app.post("/statistics/custom-period", isAuthenticated, async (req, res) => {
  const { start_date, end_date } = req.body;
  res.redirect(
    `/statistics?period=custom&start_date=${start_date}&end_date=${end_date}`
  );
});

// 404 page--------------------------------------------------------------------------------------------------------------
app.get("*", (req, res) => {
  res.render("404", {});
});

app.listen(3000, () => {
  console.log("Server listening on port 3000");
});
