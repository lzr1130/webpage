let numbers = [];
let usedNumbers = new Set();
let solutions = []; // 存储所有可能的解答

// 添加分页相关变量
const solutionsPerPage = 5;

// 检查表达式是否可以得到24
function evaluate(nums) {
    if (nums.length === 1) {
        return Math.abs(nums[0] - 24) < 0.0001;
    }
    
    for (let i = 0; i < nums.length; i++) {
        for (let j = i + 1; j < nums.length; j++) {
            const a = nums[i];
            const b = nums[j];
            const remainNums = nums.filter((_, idx) => idx !== i && idx !== j);
            
            // 尝试所有可能的运算
            if (evaluate([...remainNums, a + b])) return true;
            if (evaluate([...remainNums, a - b])) return true;
            if (evaluate([...remainNums, b - a])) return true;
            if (evaluate([...remainNums, a * b])) return true;
            if (b !== 0 && evaluate([...remainNums, a / b])) return true;
            if (a !== 0 && evaluate([...remainNums, b / a])) return true;
        }
    }
    return false;
}

// 检查表达式是否包含多余的括号
function hasRedundantParentheses(expr) {
    // 检查类似 "(1+2)" 这样整个表达式都被括号包围的情况
    if (expr.startsWith('(') && expr.endsWith(')')) {
        let count = 0;
        for (let i = 0; i < expr.length - 1; i++) {
            if (expr[i] === '(') count++;
            if (expr[i] === ')') count--;
            if (count === 0 && i < expr.length - 1) return false;
        }
        return true;
    }
    return false;
}

// 计算表达式的值
function calculateExpression(expr) {
    try {
        const evalExpr = expr.replace(/×/g, '*').replace(/÷/g, '/');
        return eval(evalExpr);
    } catch (e) {
        return null;
    }
}

// 修改查找解答的函数，找到所有答案
function findAllSolutions(nums) {
    const ops = ['+', '-', '×', '÷'];
    const used = new Array(nums.length).fill(false);
    let allResults = new Set(); // 使用Set存储所有不重复的答案

    // 规范化表达式，去除等价的括号形式
    function normalizeExpression(expr) {
        // 去除多余的括号
        while (hasRedundantParentheses(expr)) {
            expr = expr.slice(1, -1);
        }
        return expr;
    }

    // 生成所有数字的排列
    function generatePermutations(current) {
        if (current.length === nums.length) {
            // 尝试所有可能的运算符组合
            for (let i = 0; i < ops.length; i++) {
                for (let j = 0; j < ops.length; j++) {
                    for (let k = 0; k < ops.length; k++) {
                        // 尝试不同的括号组合
                        const expressions = [
                            `${current[0]}${ops[i]}${current[1]}${ops[j]}${current[2]}${ops[k]}${current[3]}`,
                            `(${current[0]}${ops[i]}${current[1]})${ops[j]}${current[2]}${ops[k]}${current[3]}`,
                            `${current[0]}${ops[i]}(${current[1]}${ops[j]}${current[2]})${ops[k]}${current[3]}`,
                            `${current[0]}${ops[i]}${current[1]}${ops[j]}(${current[2]}${ops[k]}${current[3]})`,
                            `(${current[0]}${ops[i]}${current[1]}${ops[j]}${current[2]})${ops[k]}${current[3]}`,
                            `${current[0]}${ops[i]}(${current[1]}${ops[j]}${current[2]}${ops[k]}${current[3]})`
                        ];

                        for (let expr of expressions) {
                            const value = calculateExpression(expr);
                            if (value !== null && Math.abs(value - 24) < 0.0001) {
                                // 规范化表达式后再添加
                                const normalizedExpr = normalizeExpression(expr);
                                if (normalizedExpr) {
                                    allResults.add(normalizedExpr);
                                }
                            }
                        }
                    }
                }
            }
            return;
        }

        for (let i = 0; i < nums.length; i++) {
            if (!used[i]) {
                used[i] = true;
                current.push(nums[i]);
                generatePermutations(current);
                current.pop();
                used[i] = false;
            }
        }
    }

    generatePermutations([]);
    return Array.from(allResults); // 将Set转换为数组返回
}

// 修改生成数字的函数
function generateNumbers() {
    while (true) {
        const nums = Array(4).fill(0).map(() => Math.floor(Math.random() * 13) + 1);
        solutions = findAllSolutions(nums); // 直接获取所有解答
        if (solutions.length > 0) {
            return nums;
        }
    }
}

// 修改显示答案的函数
function toggleSolutions() {
    const solutionsPanel = document.getElementById('solutions-panel');
    
    if (solutionsPanel.classList.contains('hidden')) {
        // 显示答案面板
        solutionsPanel.classList.remove('hidden');
        displaySolutions();
    } else {
        // 隐藏答案面板
        solutionsPanel.classList.add('hidden');
    }
}

// 修改显示答案的函数
function displaySolutions() {
    const solutionsList = document.getElementById('solutions-list');
    const solutionsCount = document.getElementById('solutions-count');
    const pageInfo = document.getElementById('page-info');
    const prevButton = document.getElementById('prev-page');
    const nextButton = document.getElementById('next-page');
    
    if (solutions.length === 0) {
        solutionsList.innerHTML = '<div>没有找到解答！</div>';
        solutionsCount.textContent = '';
        pageInfo.textContent = '';
        prevButton.style.display = 'none';
        nextButton.style.display = 'none';
        return;
    }
    
    // 显示答案总数
    solutionsCount.textContent = `（共${solutions.length}种解法）`;
    
    // 计算当前页的答案
    const currentPage = parseInt(solutionsList.getAttribute('data-page') || '1');
    const startIndex = (currentPage - 1) * solutionsPerPage;
    const endIndex = Math.min(startIndex + solutionsPerPage, solutions.length);
    
    // 显示当前页的答案
    solutionsList.innerHTML = solutions
        .slice(startIndex, endIndex)
        .map(solution => `<div>${solution} = 24</div>`)
        .join('');
    
    // 更新页码信息
    const totalPages = Math.ceil(solutions.length / solutionsPerPage);
    pageInfo.textContent = `第 ${currentPage} 页，共 ${totalPages} 页`;
    
    // 更新分页按钮显示状态
    prevButton.style.display = currentPage > 1 ? 'inline' : 'none';
    nextButton.style.display = currentPage < totalPages ? 'inline' : 'none';
    
    // 保存当前页码
    solutionsList.setAttribute('data-page', currentPage);
}

// 修改翻页功能函数名称
function prevSolutionsPage() {
    changePage(-1);
}

function nextSolutionsPage() {
    changePage(1);
}

// 添加翻页功能
function changePage(delta) {
    const solutionsList = document.getElementById('solutions-list');
    const currentPage = parseInt(solutionsList.getAttribute('data-page') || '1');
    const totalPages = Math.ceil(solutions.length / solutionsPerPage);
    const newPage = Math.max(1, Math.min(currentPage + delta, totalPages));
    
    solutionsList.setAttribute('data-page', newPage);
    displaySolutions();
}

// 修改生成新游戏的函数
function generateNewGame() {
    numbers = generateNumbers();
    usedNumbers.clear();
    document.getElementById('expression').value = '';
    document.getElementById('solutions-panel').classList.add('hidden');
    
    // 重置页码
    const solutionsList = document.getElementById('solutions-list');
    solutionsList.setAttribute('data-page', '1');
    
    const cards = document.querySelectorAll('.number-card');
    cards.forEach((card, index) => {
        card.textContent = numbers[index];
        card.setAttribute('data-index', index);
    });
}

// 修改删除功能，支持单个字符删除
function deleteLastChar() {
    const expression = document.getElementById('expression');
    const lastChar = expression.value.slice(-1);
    expression.value = expression.value.slice(0, -1);
    
    // 如果删除的是数字，需要从已使用集合中移除
    if (/\d/.test(lastChar)) {
        // 从后向前查找这个数字对应的卡片
        const cards = document.querySelectorAll('.number-card');
        for (let i = cards.length - 1; i >= 0; i--) {
            const card = cards[i];
            if (card.textContent === lastChar && usedNumbers.has(card.getAttribute('data-index'))) {
                usedNumbers.delete(card.getAttribute('data-index'));
                break;
            }
        }
    }
}

// 添加数字到表达式
function appendNumber(num, element) {
    const index = element.getAttribute('data-index');
    if (usedNumbers.has(index)) return;
    
    const expression = document.getElementById('expression');
    expression.value += num;
    usedNumbers.add(index);
}

// 添加运算符到表达式
function appendOperator(operator) {
    const expression = document.getElementById('expression');
    expression.value += operator;
}

// 清除表达式
function clearExpression() {
    document.getElementById('expression').value = '';
    usedNumbers.clear();
}

// 修改检查结果函数
function checkResult() {
    const expression = document.getElementById('expression').value;
    try {
        const processedExp = expression.replace(/×/g, '*').replace(/÷/g, '/');
        const result = eval(processedExp);
        
        if (Math.abs(result - 24) < 0.0001) {
            const solutionsList = document.getElementById('solutions-list');
            const solutionsCount = document.getElementById('solutions-count');
            const pageInfo = document.getElementById('page-info');
            solutionsList.innerHTML = '<div class="correct">恭喜你，答对了！</div>';
            solutionsCount.textContent = '';
            pageInfo.textContent = '';
            document.getElementById('prev-page').style.display = 'none';
            document.getElementById('next-page').style.display = 'none';
            document.getElementById('solutions-panel').classList.remove('hidden');
            setTimeout(() => {
                generateNewGame();
            }, 1500);
        } else {
            const solutionsList = document.getElementById('solutions-list');
            solutionsList.innerHTML = '<div class="wrong">答案不正确，请重试！</div>';
            document.getElementById('solutions-panel').classList.remove('hidden');
            setTimeout(() => {
                document.getElementById('solutions-panel').classList.add('hidden');
            }, 1500);
        }
    } catch (e) {
        const solutionsList = document.getElementById('solutions-list');
        solutionsList.innerHTML = '<div class="wrong">表达式不合法，请检查！</div>';
        document.getElementById('solutions-panel').classList.remove('hidden');
        setTimeout(() => {
            document.getElementById('solutions-panel').classList.add('hidden');
        }, 1500);
    }
}

// 页面加载时开始新游戏
window.onload = generateNewGame; 